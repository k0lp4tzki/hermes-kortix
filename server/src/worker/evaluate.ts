import { q, notify, tx } from '../db/pool.js';
import { resourceOwnStatus, worst, SEVERITY } from '../core/state.js';
import { takeDirty } from './dirty.js';
import { setStat } from './loops.js';

let lastFull = 0;

/**
 * Derives each resource's status from its checks. Runs when results arrived (dirty) or at
 * least every 30 s. Dependency analysis and incidents hook in here (see milestone 4).
 */
export async function evaluateTick() {
  if (!takeDirty() && Date.now() - lastFull < 30_000) return;
  lastFull = Date.now();
  const t0 = performance.now();
  const resources = await q(`SELECT id, monitoring_enabled, status, own_status, status_message, last_ok_at FROM resources`);
  const checks = await q(`SELECT resource_id, state, last_message, name, last_ok_at FROM checks WHERE enabled`);
  const byRes = new Map<string, any[]>();
  for (const c of checks) byRes.set(c.resource_id, [...(byRes.get(c.resource_id) ?? []), c]);
  const updates: any[] = [];
  for (const r of resources) {
    const cs = byRes.get(r.id) ?? [];
    const own = resourceOwnStatus(cs.map((c) => c.state));
    const status = r.monitoring_enabled ? own : 'unmonitored';
    const worstCheck = cs.filter((c) => c.state === own && own !== 'ok' && own !== 'pending').sort((a, b) => (SEVERITY[b.state] ?? 0) - (SEVERITY[a.state] ?? 0))[0];
    const message = !r.monitoring_enabled ? null : cs.length === 0 ? 'Keine Checks konfiguriert' : worstCheck ? `${worstCheck.name}: ${worstCheck.last_message ?? ''}`.slice(0, 500) : null;
    const lastOk = cs.reduce<Date | null>((acc, c) => (c.last_ok_at && (!acc || c.last_ok_at > acc) ? c.last_ok_at : acc), null);
    if (status !== r.status || own !== r.own_status || message !== r.status_message || String(lastOk) !== String(r.last_ok_at)) updates.push({ id: r.id, status, own, message, lastOk, changed: status !== r.status });
  }
  if (updates.length) {
    await tx(async (c) => {
      for (const u of updates) {
        await q(`UPDATE resources SET status = $2, own_status = $3, status_message = $4, last_ok_at = $5,
          status_since = CASE WHEN $6 THEN now() ELSE status_since END, last_change_at = CASE WHEN $6 THEN now() ELSE last_change_at END WHERE id = $1`,
          [u.id, u.status, u.own, u.message, u.lastOk, u.changed], c);
      }
    });
    if (updates.some((u) => u.changed)) await notify('state');
  }
  setStat('evaluate_ms', Math.round(performance.now() - t0));
  setStat('resources', resources.length);
  void worst;
}
