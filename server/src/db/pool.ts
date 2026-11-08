import pg from 'pg';
import { config } from '../lib/config.js';

// numeric/bigint → JS number (metric values are doubles anyway, counts fit in 2^53)
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, application_name: process.env.HERMES_COMPONENT ?? 'hermes' });

export type Queryable = pg.Pool | pg.PoolClient;

export async function q<T = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T[]> {
  const res = await db.query(text, params as any[]);
  return res.rows as T[];
}

export async function q1<T = any>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T | undefined> {
  const rows = await q<T>(text, params, db);
  return rows[0];
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Publish a live-update notification; the API relays it to browsers via SSE. */
export async function notify(topic: string, payload: Record<string, unknown> = {}, db: Queryable = pool) {
  const body = JSON.stringify({ topic, ...payload });
  await db.query('SELECT pg_notify($1, $2)', ['hermes_live', body.length > 7900 ? JSON.stringify({ topic }) : body]);
}

export async function waitForDb(log: (m: string) => void, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      log(`database not ready (${(e as Error).message}), retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('database not reachable');
}
