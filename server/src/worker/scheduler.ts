import { pool, q, q1, notify } from '../db/pool.js';
import { config } from '../lib/config.js';
import { unseal } from '../lib/crypto.js';
import { logger, errMsg } from '../lib/log.js';
import { executors } from '../checks/registry.js';
import { ConfigError, type CheckOutcome } from '../checks/types.js';
import { evaluateThresholds, stepState, worst, type CheckStateData } from '../core/state.js';
import type { State } from '../core/types.js';
import { setStat } from './loops.js';
import { markDirty } from './dirty.js';

const log = logger('scheduler');
let inflight = 0;
let executed = 0;
let lagSum = 0;
let notifyTimer: NodeJS.Timeout | null = null;

function liveNotify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; notify('state').catch(() => {}); }, 1000);
}

export function schedulerStats() { return { inflight, executed }; }

/** Claims due checks (SKIP LOCKED, so several workers can share the load) and runs them. */
export async function schedulerTick() {
  const free = config.workerConcurrency - inflight;
  setStat('checks_inflight', inflight);
  setStat('checks_executed', executed);
  setStat('avg_pickup_lag_ms', executed ? Math.round(lagSum / executed) : 0);
  if (free <= 0) return;
  const rows = await q(`WITH due AS (
      SELECT c.id, c.next_run AS due_at FROM checks c JOIN resources r ON r.id = c.resource_id
      WHERE c.enabled AND r.monitoring_enabled AND c.next_run <= now()
      ORDER BY c.next_run LIMIT $1 FOR UPDATE OF c SKIP LOCKED)
    UPDATE checks c SET next_run = now() + make_interval(secs => c.interval_s) FROM due WHERE c.id = due.id
    RETURNING c.*, due.due_at`, [free]);
  for (const row of rows) {
    inflight++;
    lagSum += Date.now() - new Date(row.due_at).getTime();
    runCheck(row).catch((e) => log.error('check processing failed', { check: row.id, err: errMsg(e) })).finally(() => { inflight--; executed++; });
  }
}

async function runCheck(check: any) {
  const ex = executors[check.type];
  const resource = await q1(`SELECT id, name, kind, connection, discovered FROM resources WHERE id = $1`, [check.resource_id]);
  if (!resource) return;
  let outcome: CheckOutcome;
  const t0 = performance.now();
  const ac = new AbortController();
  const hardTimeout = check.timeout_ms + 3000;
  try {
    if (!ex) throw new ConfigError(`unbekannter Check-Typ ${check.type}`);
    let secret: { kind: string; value: string } | null = null;
    if (check.secret_id) {
      const s = await q1(`SELECT kind, ciphertext, iv, auth_tag FROM secrets WHERE id = $1`, [check.secret_id]);
      if (s) secret = { kind: s.kind, value: unseal({ ciphertext: s.ciphertext, iv: s.iv, authTag: s.auth_tag }) };
    }
    outcome = await Promise.race([
      ex.run({ check, resource, secret, signal: ac.signal }),
      new Promise<CheckOutcome>((_, rej) => setTimeout(() => { ac.abort(); rej(new Error(`Zeitüberschreitung nach ${hardTimeout} ms`)); }, hardTimeout)),
    ]);
  } catch (e) {
    outcome = e instanceof ConfigError
      ? { status: 'unknown', message: `Konfiguration unvollständig: ${e.message}` }
      : { status: e instanceof Error && /Zeitüberschreitung/.test(e.message) ? 'critical' : 'unknown', message: `Prüfung fehlgeschlagen: ${errMsg(e)}` };
  }
  const duration = performance.now() - t0;
  await processResult(check, outcome, duration);
}

export async function processResult(check: any, outcome: CheckOutcome, duration: number) {
  const values: Record<string, number> = {};
  for (const [k, v] of Object.entries(outcome.metrics ?? {})) if (Number.isFinite(v.value)) values[k] = v.value;
  const thr = evaluateThresholds(values, check.thresholds ?? []);
  const raw: State = worst([outcome.status, thr.state]);
  const thrMsg = thr.breaches.map((b) => `${b.metric} ${fmtVal(b.value)} ${b.op} ${b.limit} (${b.level})`).join('; ');
  const message = [outcome.message, thrMsg].filter(Boolean).join(' · ').slice(0, 2000);
  const now = new Date();
  const prev: CheckStateData = {
    state: check.state, soft_state: check.soft_state, soft_count: check.soft_count, streak_started_at: check.streak_started_at,
    recent_raw: check.recent_raw ?? [], flapping: check.flapping, flap_score: check.flap_score,
  };
  const { next, transition, flappingChanged } = stepState(prev, raw, { fail_after: check.fail_after, recover_after: check.recover_after, hold_s: check.hold_s }, now);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const exists = await c.query(`SELECT 1 FROM checks WHERE id = $1 FOR UPDATE`, [check.id]);
    if (!exists.rowCount) { await c.query('ROLLBACK'); return; }
    await c.query(`INSERT INTO check_results(time, check_id, resource_id, raw_state, state, duration_ms, message) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [now, check.id, check.resource_id, raw, next.state, duration, message]);
    const entries = Object.entries(outcome.metrics ?? {}).filter(([, v]) => Number.isFinite(v.value));
    if (entries.length) {
      const params: unknown[] = [now, check.resource_id, check.id];
      const tuples = entries.map(([k, v], i) => { params.push(k, v.value); return `($1,$2,$3,$${4 + i * 2},$${5 + i * 2})`; });
      await c.query(`INSERT INTO metrics(time, resource_id, check_id, metric, value) VALUES ${tuples.join(',')}`, params);
      const p2: unknown[] = [check.resource_id, check.id, now];
      const t2 = entries.map(([k, v], i) => { p2.push(k, v.unit ?? null, v.label ?? null, v.value); return `($1,$${4 + i * 4},$2,$${5 + i * 4},$${6 + i * 4},$${7 + i * 4},$3)`; });
      await c.query(`INSERT INTO metric_series(resource_id, metric, check_id, unit, label, last_value, last_time) VALUES ${t2.join(',')}
        ON CONFLICT (resource_id, metric) DO UPDATE SET check_id = EXCLUDED.check_id, unit = EXCLUDED.unit, label = COALESCE(EXCLUDED.label, metric_series.label), last_value = EXCLUDED.last_value, last_time = EXCLUDED.last_time`, p2);
    }
    const lastMetrics = { ...values, _carry: outcome.carry ?? {}, _unavailable: outcome.unavailable ?? {} };
    await c.query(`UPDATE checks SET state = $2, state_since = CASE WHEN $3 THEN $4 ELSE state_since END, soft_state = $5, soft_count = $6, streak_started_at = $7,
        recent_raw = $8, flapping = $9, flap_score = $10, last_run = $4, last_duration_ms = $11, last_message = $12, last_raw_state = $13, last_metrics = $14,
        last_ok_at = CASE WHEN $13 = 'ok' THEN $4 ELSE last_ok_at END WHERE id = $1`,
      [check.id, next.state, !!transition, now, next.soft_state, next.soft_count, next.streak_started_at, next.recent_raw, next.flapping, next.flap_score, duration, message, raw, lastMetrics]);
    if (transition) {
      const label = (s: string) => ({ ok: 'OK', warning: 'Warning', critical: 'Critical', unknown: 'Unknown', pending: 'ausstehend' } as Record<string, string>)[s] ?? s;
      await c.query(`INSERT INTO events(time, resource_id, check_id, kind, severity, message, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        now, check.resource_id, check.id, transition.recovery ? 'recovery' : 'state_change', transition.to,
        `${check.name}: ${label(transition.from)} → ${label(transition.to)}${transition.recovery ? ' (Recovery)' : ''} – ${message.slice(0, 300)}`,
        { from: transition.from, to: transition.to, raw, breaches: thr.breaches }]);
    }
    if (flappingChanged) {
      await c.query(`INSERT INTO events(time, resource_id, check_id, kind, severity, message, data) VALUES ($1,$2,$3,'flapping',$4,$5,$6)`, [
        now, check.resource_id, check.id, next.flapping ? 'warning' : 'info',
        next.flapping ? `${check.name}: Zustand flattert (${next.flap_score} % Wechsel) – Benachrichtigungen werden zurückgehalten` : `${check.name}: Zustand wieder stabil`, { flap_score: next.flap_score }]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  markDirty();
  liveNotify();
  if (transition || flappingChanged) notify('events').catch(() => {});
}

function fmtVal(v: number) { return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, ''); }
