import { q } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger, errMsg } from '../lib/log.js';

const log = logger('retention');

/** (Re)applies TimescaleDB retention policies from the environment on every start. */
export async function applyRetention() {
  const r = config.retention;
  const policies: Array<[string, number]> = [['metrics', r.rawMetricsDays], ['check_results', r.checkResultsDays], ['metrics_5m', r.metrics5mDays], ['metrics_1h', r.metrics1hDays]];
  for (const [rel, days] of policies) {
    try {
      await q(`SELECT remove_retention_policy($1, if_exists => true)`, [rel]);
      await q(`SELECT add_retention_policy($1, drop_after => make_interval(days => $2))`, [rel, days]);
    } catch (e) {
      log.warn('retention policy failed', { rel, err: errMsg(e) });
    }
  }
  log.info('retention policies applied', { ...r });
}

/** Plain tables (events, notifications) are pruned by the worker. */
export async function pruneTick() {
  await q(`DELETE FROM events WHERE time < now() - make_interval(days => $1)`, [config.retention.eventsDays]);
  await q(`DELETE FROM notifications WHERE time < now() - make_interval(days => $1)`, [config.retention.eventsDays]);
  await q(`DELETE FROM user_sessions WHERE expires_at < now()`);
  await q(`DELETE FROM audit_log WHERE time < now() - make_interval(days => $1)`, [config.retention.eventsDays]);
}
