/**
 * The migration runner, and a check that the schema really carries the
 * mechanisms the rest of the suite relies on.
 */

import { describe, expect, it } from 'vitest'

import { Database } from '../src/database.js'
import { loadMigrations } from '../src/migrations.js'

describe('migration runner', () => {
  it('applies every file once and is a no-op on the second run', async () => {
    const db = await Database.create()
    try {
      const files = await loadMigrations()
      expect(files.map((m) => m.id)).toEqual([...files.map((m) => m.id)].sort())
      expect(files.length).toBeGreaterThanOrEqual(13)

      // Database.create already migrated, so a second call must apply nothing.
      const second = await db.migrate()
      expect(second.map((m) => m.id)).toEqual(files.map((m) => m.id))
      expect(second.every((m) => !m.applied)).toBe(true)
    } finally {
      await db.close()
    }
  })

  it('refuses to continue when an applied migration file has changed', async () => {
    const db = await Database.create()
    try {
      await db.admin((session) =>
        session.query(
          "update ledger.schema_migrations set checksum = 'tampered' where id = $1",
          ['0006_balanced_entries'],
        ),
      )

      await expect(db.migrate()).rejects.toThrow(
        /0006_balanced_entries was applied with checksum tampered/,
      )
    } finally {
      await db.close()
    }
  })
})

describe('the deployed schema', () => {
  it('carries the constraint triggers that enforce balance, deferred', async () => {
    const db = await Database.create()
    try {
      const triggers = await db.admin((session) =>
        session.query<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>(
          `select t.tgname, t.tgdeferrable, t.tginitdeferred
             from pg_trigger t
             join pg_proc p on p.oid = t.tgfoid
            where p.proname = 'assert_entry_balanced'
            order by t.tgname`,
        ),
      )

      expect(triggers.map((t) => t.tgname)).toEqual([
        'journal_entries_balanced',
        'journal_lines_keep_entry_balanced',
      ])
      // A trigger that is not INITIALLY DEFERRED would fire mid-statement and
      // reject every multi-line entry.
      expect(triggers.every((t) => t.tgdeferrable && t.tginitdeferred)).toBe(true)
    } finally {
      await db.close()
    }
  })

  it('hands every object to ledger_owner and grants ledger_app no write on the journal', async () => {
    const db = await Database.create()
    try {
      const owners = await db.admin((session) =>
        session.query<{ owner: string; n: number }>(
          `select pg_get_userbyid(relowner) as owner, count(*)::int as n
             from pg_class
            where relnamespace = 'ledger'::regnamespace and relkind in ('r', 'v')
            group by 1`,
        ),
      )
      expect(owners).toEqual([{ owner: 'ledger_owner', n: expect.any(Number) as unknown as number }])

      const journalPrivileges = await db.admin((session) =>
        session.query<{ privilege_type: string }>(
          `select privilege_type
             from information_schema.table_privileges
            where table_schema = 'ledger'
              and table_name in ('journal_entries', 'journal_lines')
              and grantee = 'ledger_app'
            group by privilege_type
            order by privilege_type`,
        ),
      )
      expect(journalPrivileges.map((p) => p.privilege_type)).toEqual(['INSERT', 'SELECT'])
    } finally {
      await db.close()
    }
  })
})
