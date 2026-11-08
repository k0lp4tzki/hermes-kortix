import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { logger } from '../lib/log.js';

const log = logger('migrate');
const MIGRATIONS_DIR = process.env.HERMES_MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Applies pending SQL migrations in order. Safe to call from several processes (advisory lock). */
export async function migrate() {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(424242)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
      log.info(`applying ${f}`);
      // continuous aggregates cannot be created inside a transaction block; files marked
      // with "-- hermes:no-transaction" run statement by statement.
      if (sql.includes('-- hermes:no-transaction')) {
        for (const stmt of splitSql(sql)) await c.query(stmt);
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      } else {
        await c.query('BEGIN');
        try {
          await c.query(sql);
          await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw new Error(`migration ${f} failed: ${(e as Error).message}`);
        }
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    c.release();
  }
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}
