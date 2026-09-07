/**
 * The database handle and the session model.
 *
 * There is exactly one way to touch tenant data: `asTenant`, which opens a
 * transaction, sets `app.tenant_id` for its duration and drops to a role that
 * row level security applies to. Nothing in this codebase queries a
 * tenant-scoped table outside that wrapper, which is what makes "the app
 * cannot see another tenant's rows" a property of the connection rather than
 * a habit of the query authors.
 *
 * `set_config(..., is_local => true)` and `SET LOCAL ROLE` both unwind when
 * the transaction ends, so a connection cannot leak one request's tenant into
 * the next.
 */

import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import type { Transaction } from '@electric-sql/pglite'

import { mapDatabaseError } from './errors.js'
import { loadMigrations } from './migrations.js'
import type { Uuid } from './types.js'

/**
 * `ledger_app` is what the application uses. `ledger_owner` owns the schema
 * and exists so the tests can prove that FORCE ROW LEVEL SECURITY and the
 * immutability triggers hold even for the role that owns the tables.
 */
export type LedgerRole = 'ledger_app' | 'ledger_owner'

const KNOWN_ROLES: readonly LedgerRole[] = ['ledger_app', 'ledger_owner']

export interface DatabaseOptions {
  /** Directory for a persistent database. Omit for an in-memory instance. */
  dataDir?: string
  /** Override the location of the `sql/` directory. */
  migrationsDir?: string
}

export interface AppliedMigration {
  id: string
  checksum: string
  /** False when the migration was already recorded and was skipped. */
  applied: boolean
}

/** A row as PostgreSQL returned it: snake_case keys, numerics as strings. */
export type Row = Record<string, unknown>

/** A transaction already scoped to one tenant and one role. */
export class Session {
  private readonly tx: Transaction

  constructor(tx: Transaction) {
    this.tx = tx
  }

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      const result = await this.tx.query<T>(sql, params)
      return result.rows
    } catch (error) {
      throw mapDatabaseError(error)
    }
  }

  async maybeOne<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params)
    if (rows.length > 1) {
      throw new Error(`Expected at most one row, got ${rows.length}`)
    }
    return rows[0]
  }

  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T> {
    const row = await this.maybeOne<T>(sql, params)
    if (row === undefined) throw new Error('Expected exactly one row, got none')
    return row
  }

  async exec(sql: string): Promise<void> {
    try {
      await this.tx.exec(sql)
    } catch (error) {
      throw mapDatabaseError(error)
    }
  }
}

export class Database {
  readonly pg: PGlite
  private readonly migrationsDir: string | undefined

  private constructor(pg: PGlite, migrationsDir: string | undefined) {
    this.pg = pg
    this.migrationsDir = migrationsDir
  }

  /**
   * Start an in-process PostgreSQL 18 and bring the schema up to date.
   *
   * btree_gist has to be registered with the instance before it can be
   * created: the accounting-period exclusion constraint mixes an equality
   * column with a range column, which core GiST cannot index on its own.
   */
  static async create(options: DatabaseOptions = {}): Promise<Database> {
    const pg =
      options.dataDir === undefined
        ? await PGlite.create({ extensions: { btree_gist } })
        : await PGlite.create(options.dataDir, { extensions: { btree_gist } })

    const db = new Database(pg, options.migrationsDir)
    await db.migrate()
    return db
  }

  /**
   * Apply every migration that has not been applied yet.
   *
   * Re-running is a no-op. A migration whose file changed after it was
   * applied is an error, not a silent skip: a schema that does not match its
   * source is the one thing worse than a schema that failed to deploy.
   */
  async migrate(): Promise<AppliedMigration[]> {
    await this.pg.exec(`
      create schema if not exists ledger;
      create table if not exists ledger.schema_migrations (
        id          text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      );
    `)

    const recorded = new Map<string, string>(
      (
        await this.pg.query<{ id: string; checksum: string }>(
          'select id, checksum from ledger.schema_migrations',
        )
      ).rows.map((row) => [row.id, row.checksum]),
    )

    const results: AppliedMigration[] = []

    for (const migration of await loadMigrations(this.migrationsDir)) {
      const previous = recorded.get(migration.id)

      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration ${migration.id} was applied with checksum ${previous} but the file ` +
              `on disk hashes to ${migration.checksum}. Add a new migration instead of editing it.`,
          )
        }
        results.push({ id: migration.id, checksum: migration.checksum, applied: false })
        continue
      }

      try {
        await this.pg.transaction(async (tx) => {
          await tx.exec(migration.sql)
          await tx.query(
            'insert into ledger.schema_migrations (id, checksum) values ($1, $2)',
            [migration.id, migration.checksum],
          )
        })
      } catch (error) {
        throw new Error(`Migration ${migration.id} failed: ${(error as Error).message}`, {
          cause: error,
        })
      }

      results.push({ id: migration.id, checksum: migration.checksum, applied: true })
    }

    return results
  }

  /**
   * Run a transaction as the superuser with no tenant set.
   *
   * Provisioning a tenant is the only thing the application layer needs this
   * for: `ledger_app` has SELECT on `tenants` and nothing more.
   */
  async admin<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    try {
      return await this.pg.transaction(async (tx) => {
        await tx.exec('set local search_path to ledger, public')
        return fn(new Session(tx))
      })
    } catch (error) {
      throw mapDatabaseError(error)
    }
  }

  /**
   * Run a transaction scoped to one tenant.
   *
   * The mapping of driver errors happens around the whole transaction, not
   * just around individual statements, because the deferred constraint
   * trigger that enforces balance raises at COMMIT.
   */
  async asTenant<T>(
    tenantId: Uuid,
    fn: (session: Session) => Promise<T>,
    options: { role?: LedgerRole } = {},
  ): Promise<T> {
    const role = options.role ?? 'ledger_app'
    if (!KNOWN_ROLES.includes(role)) {
      throw new Error(`Unknown role: ${role}`)
    }

    try {
      return await this.pg.transaction(async (tx) => {
        await tx.exec('set local search_path to ledger, public')
        await tx.query('select set_config($1, $2, true)', ['app.tenant_id', tenantId])
        // Role names cannot be parameterised; the allow-list above is what
        // makes this interpolation safe.
        await tx.exec(`set local role ${role}`)
        return fn(new Session(tx))
      })
    } catch (error) {
      throw mapDatabaseError(error)
    }
  }

  async close(): Promise<void> {
    await this.pg.close()
  }
}
