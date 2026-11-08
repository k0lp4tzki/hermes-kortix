import { hostname } from 'node:os';
import { q } from '../db/pool.js';

const started = new Date();
export function startHeartbeat(component: string, info: () => Record<string, unknown> = () => ({}), everyMs = 10_000) {
  const beat = () =>
    q(`INSERT INTO platform_heartbeats(component, instance, started_at, last_beat, info) VALUES ($1,$2,$3,now(),$4)
       ON CONFLICT (component) DO UPDATE SET instance = EXCLUDED.instance, started_at = EXCLUDED.started_at, last_beat = now(), info = EXCLUDED.info`,
      [component, `${hostname()}:${process.pid}`, started, { ...info(), pid: process.pid, rss: process.memoryUsage().rss, uptime_s: Math.round(process.uptime()) }]).catch(() => {});
  beat();
  return setInterval(beat, everyMs);
}
