import { q, notify, tx } from '../db/pool.js';
import { resourceOwnStatus, SEVERITY } from '../core/state.js';
import { analyzeDependencies, maintenanceScope } from '../core/deps.js';
import { takeDirty } from './dirty.js';
import { setStat } from './loops.js';
import { syncIncidents } from './incidents.js';

let lastFull = 0;
const same = (a: unknown[] | null | undefined, b: unknown[]) => JSON.stringify(a ?? []) === JSON.stringify(b);

/**
 * The evaluation pipeline, run when check results arrived or at least every 15 s:
 * 1. resource status from its own checks
 * 2. dependency analysis: root causes, symptoms, downstream impact
 * 3. maintenance windows
 * 4. incidents + notifications (root causes only)
 */
export async function evaluateTick() {
  if (!takeDirty() && Date.now() - lastFull < 15_000) return;
  lastFull = Date.now();
  const t0 = performance.now();
  const resources = await q(`SELECT id, COALESCE(display_name, name) AS label, tags, monitoring_enabled, status, own_status, status_message, last_ok_at,
    root_cause_ids, impacted_by, in_maintenance FROM resources`);
  const checks = await q(`SELECT resource_id, state, last_message, name, last_ok_at FROM checks WHERE enabled`);
  const edges = await q(`SELECT from_id AS "from", to_id AS "to", strength FROM dependencies WHERE NOT suppressed`);
  const windows = await q(`SELECT resource_ids, match_tags, include_dependents FROM maintenance_windows WHERE starts_at <= now() AND ends_at > now()`);

  const byRes = new Map<string, any[]>();
  for (const c of checks) byRes.set(c.resource_id, [...(byRes.get(c.resource_id) ?? []), c]);
  const computed = new Map<string, any>();
  for (const r of resources) {
    const cs = byRes.get(r.id) ?? [];
    const own = resourceOwnStatus(cs.map((c) => c.state));
    const status = r.monitoring_enabled ? own : 'unmonitored';
    const worstCheck = cs.filter((c) => c.state === own && own !== 'ok' && own !== 'pending').sort((a, b) => (SEVERITY[b.state] ?? 0) - (SEVERITY[a.state] ?? 0))[0];
    const message = !r.monitoring_enabled ? null : cs.length === 0 ? 'Keine Checks konfiguriert' : worstCheck ? `${worstCheck.name}: ${worstCheck.last_message ?? ''}`.slice(0, 500) : null;
    const lastOk = cs.reduce<Date | null>((acc, c) => (c.last_ok_at && (!acc || c.last_ok_at > acc) ? c.last_ok_at : acc), null);
    computed.set(r.id, { ...r, status, own, message, lastOk });
  }

  const deps = analyzeDependencies([...computed.values()].map((r) => ({ id: r.id, status: r.status, monitored: r.monitoring_enabled })), edges);
  const maint = maintenanceScope(windows, resources.map((r) => ({ id: r.id, tags: r.tags ?? [] })), edges);

  const updates: any[] = [];
  for (const r of computed.values()) {
    const rootCauses = deps.rootCauses.get(r.id) ?? [];
    const impacted = deps.impactedBy.get(r.id) ?? [];
    const inMaint = maint.has(r.id);
    let message = r.message;
    if (rootCauses.length) message = `Folgefehler von ${rootCauses.map((id) => computed.get(id)?.label).join(', ')} · ${message ?? ''}`.slice(0, 500);
    else if (impacted.length && r.status === 'ok') message = `Betroffen durch Störung von ${impacted.map((id) => computed.get(id)?.label).join(', ')}`;
    const changed = r.status !== resources.find((x) => x.id === r.id)!.status;
    if (changed || r.own !== r.own_status || message !== r.status_message || String(r.lastOk) !== String(r.last_ok_at) || !same(r.root_cause_ids, rootCauses) || !same(r.impacted_by, impacted) || inMaint !== r.in_maintenance) {
      updates.push({ id: r.id, status: r.status, own: r.own, message, lastOk: r.lastOk, changed, rootCauses, impacted, inMaint, maintChanged: inMaint !== r.in_maintenance });
    }
    r.status_message = message;
  }
  if (updates.length) {
    await tx(async (c) => {
      for (const u of updates) {
        await q(`UPDATE resources SET status = $2, own_status = $3, status_message = $4, last_ok_at = $5, root_cause_ids = $7, impacted_by = $8, in_maintenance = $9,
          status_since = CASE WHEN $6 THEN now() ELSE status_since END, last_change_at = CASE WHEN $6 THEN now() ELSE last_change_at END WHERE id = $1`,
          [u.id, u.status, u.own, u.message, u.lastOk, u.changed, u.rootCauses, u.impacted, u.inMaint], c);
        if (u.maintChanged) await q(`INSERT INTO events(resource_id, kind, severity, message) VALUES ($1,'maintenance','info',$2)`, [u.id, u.inMaint ? 'Wartungsfenster begonnen – Alarme unterdrückt' : 'Wartungsfenster beendet'], c);
      }
    });
    await notify('state');
  }
  await syncIncidents(computed, deps, maint);
  setStat('evaluate_ms', Math.round(performance.now() - t0));
  setStat('resources', resources.length);
  setStat('root_causes', deps.roots.size);
}
