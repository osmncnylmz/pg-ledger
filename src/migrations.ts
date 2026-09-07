/**
 * The `sql/` directory is the schema. Files load in filename order and carry a
 * SHA-256 of their contents, so a file edited after it was applied gets
 * reported rather than silently ignored.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Migration {
  /** Filename without the `.sql` suffix, for example `0006_balanced_entries`. */
  id: string
  path: string
  sql: string
  checksum: string
}

const FIRST_MIGRATION = '0001_foundation.sql'

/**
 * Walks up from this module, so `sql/` resolves the same way whether the code
 * is running from `src/` under vitest or from `dist/` after a build.
 */
export async function findMigrationsDir(from = fileURLToPath(import.meta.url)): Promise<string> {
  let dir = dirname(from)

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'sql')
    try {
      await stat(join(candidate, FIRST_MIGRATION))
      return candidate
    } catch {
      // Not here; keep walking up.
    }

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  throw new Error(
    `Could not locate the sql/ migrations directory starting from ${from}. ` +
      'Pass migrationsDir explicitly.',
  )
}

export async function loadMigrations(dir?: string): Promise<Migration[]> {
  const resolved = resolve(dir ?? (await findMigrationsDir()))
  const entries = (await readdir(resolved)).filter((name) => name.endsWith('.sql')).sort()

  if (entries.length === 0) {
    throw new Error(`No .sql migrations found in ${resolved}`)
  }

  return Promise.all(
    entries.map(async (name) => {
      const path = join(resolved, name)
      const sql = await readFile(path, 'utf8')
      return {
        id: name.replace(/\.sql$/, ''),
        path,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      }
    }),
  )
}
