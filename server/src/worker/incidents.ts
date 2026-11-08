import { q, notify } from '../db/pool.js';
import { decideNotification } from '../core/alerting.js';
import type { DepResult } from '../core/deps.js';
import { dispatch } from '../alerting/dispatch.js';
import { logger, errMsg } from '../lib/log.js';

const log = logger('incidents');
const SEV_LABEL: Record<string, string> = { warning: 'Warning', critical: 'Critical', unknown: 'Unknown' };

/**
 * Opens/updates/resolves incidents for root causes and drives notifications.
 * Symptoms (resources explained by an upstream failure) never get their own incident.
 */
export async function syncIncidents(resources: Map<string, any>, deps: DepResult, maint: Set<string>) {
  const open = await q(`SELECT * FROM incidents WHERE status = 'open'`);
  const openByRes = new Map(open.map((i) => [i.resource_id, i]));
  const failingChecks = await q(`SELECT id, resource_id, flapping FROM checks WHERE enabled AND state IN ('warning','critical')`);
  const checksByRes = new Map<string, any[]>();
  for (const c of failingChecks) checksByRes.set(c.resource_id, [...(checksByRes.get(c.resource_id) ?? []), c]);
  let changed = false;

  // symptoms per root
  const symptomsOf = new Map<string, string[]>();
  for (const [sym, roots] of deps.rootCauses) for (const r of roots) symptomsOf.set(r, [...(symptomsOf.get(r) ?? []), sym]);

  for (const rootId of deps.roots) {
    const r = resources.get(rootId);
    if (!r || !r.monitoring_enabled || !['warning', 'critical'].includes(r.status)) continue;
    const affected = deps.downstream.get(rootId) ?? [];
    const suppressed = (symptomsOf.get(rootId) ?? []).sort();
    const cks = checksByRes.get(rootId) ?? [];
    const flapping = cks.some((c) => c.flapping);
    const inMaint = maint.has(rootId);
    const cur = openByRes.get(rootId);
    if (!cur) {
      const occ = (await q(`SELECT count(*)::int AS n FROM incidents WHERE resource_id = $1 AND opened_at > now() - interval '7 days'`, [rootId]))[0].n + 1;
      const title = `${r.label}: ${r.status_message ?? SEV_LABEL[r.status]}`.slice(0, 300);
      const [inc] = await q(`INSERT INTO incidents(resource_id, severity, peak_severity, title, affected_ids, suppressed_ids, check_ids, flapping, in_maintenance, occurrences_7d)
        VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [rootId, r.status, title, affected, suppressed, cks.map((c) => c.id), flapping, inMaint, occ]);
      await q(`INSERT INTO events(resource_id, incident_id, kind, severity, message, data) VALUES ($1,$2,'incident_opened',$3,$4,$5)`, [rootId, inc.id, r.status,
        `Störung eröffnet (${SEV_LABEL[r.status]})${affected.length ? `, ${affected.length} nachgelagerte Komponenten betroffen` : ''}${occ > 1 ? `, ${occ}. Mal in 7 Tagen` : ''}`, { affected, suppressed }]);
      openByRes.set(rootId, inc);
      changed = true;
    } else {
      const sevChanged = cur.severity !== r.status;
      const setChanged = JSON.stringify(cur.affected_ids) !== JSON.stringify(affected) || JSON.stringify(cur.suppressed_ids) !== JSON.stringify(suppressed);
      if (sevChanged || setChanged || cur.flapping !== flapping || cur.in_maintenance !== inMaint) {
        const peak = cur.peak_severity === 'critical' || r.status === 'critical' ? 'critical' : r.status;
        const [upd] = await q(`UPDATE incidents SET severity = $2, peak_severity = $3, affected_ids = $4, suppressed_ids = $5, check_ids = $6, flapping = $7, in_maintenance = $8,
            last_change_at = now() WHERE id = $1 RETURNING *`, [cur.id, r.status, peak, affected, suppressed, cks.map((c) => c.id), flapping, inMaint]);
        if (sevChanged) await q(`INSERT INTO events(resource_id, incident_id, kind, severity, message) VALUES ($1,$2,'incident_changed',$3,$4)`,
          [rootId, cur.id, r.status, `Störung ${r.status === 'critical' ? 'eskaliert' : 'herabgestuft'}: ${SEV_LABEL[cur.severity]} → ${SEV_LABEL[r.status]}`]);
        openByRes.set(rootId, upd);
        changed = true;
      }
    }
  }

  // resolve incidents whose root recovered or turned out to be a symptom of another root
  for (const inc of open) {
    const r = resources.get(inc.resource_id);
    const stillRoot = r && r.monitoring_enabled && deps.roots.has(inc.resource_id) && ['warning', 'critical'].includes(r.status);
    if (stillRoot) continue;
    const explainedBy = r ? deps.rootCauses.get(inc.resource_id) : undefined;
    const reason = !r ? 'Ressource entfernt' : !r.monitoring_enabled ? 'Überwachung deaktiviert' : explainedBy?.length
      ? `Folgefehler von ${explainedBy.map((id) => resources.get(id)?.label ?? id).join(', ')}` : r.status === 'unknown' ? 'Zustand unbekannt' : 'Recovery';
    const [res] = await q(`UPDATE incidents SET status = 'resolved', resolved_at = now(), last_change_at = now(), summary = $2 WHERE id = $1 RETURNING *`, [inc.id, reason]);
    const durS = Math.round((Date.now() - new Date(inc.opened_at).getTime()) / 1000);
    await q(`INSERT INTO events(resource_id, incident_id, kind, severity, message) VALUES ($1,$2,'incident_resolved','ok',$3)`,
      [r ? inc.resource_id : null, inc.id, `Störung beendet nach ${durS < 120 ? durS + ' s' : Math.round(durS / 60) + ' min'} (${reason})`]);
    openByRes.set(inc.resource_id, res);
    changed = true;
  }

  // notifications
  const routes = await q(`SELECT max(repeat_interval_s)::int AS rep FROM routing_rules WHERE enabled`);
  const repeat = routes[0]?.rep ?? 0;
  const candidates = await q(`SELECT * FROM incidents WHERE status = 'open' OR (status = 'resolved' AND notified_state IN ('warning','critical'))`);
  for (const inc of candidates) {
    const d = decideNotification({ status: inc.status, severity: inc.severity, notified_state: inc.notified_state, last_notified_at: inc.last_notified_at,
      flapping: inc.flapping, in_maintenance: inc.in_maintenance, acknowledged: !!inc.acknowledged_at }, repeat, new Date());
    if (d.action === 'none') continue;
    try {
      // persist the dedup state first so a crash cannot produce duplicate sends
      await q(`UPDATE incidents SET notified_state = $2, last_notified_at = CASE WHEN $3 THEN now() ELSE last_notified_at END WHERE id = $1`, [inc.id, d.newState, d.action === 'send']);
      if (d.action === 'send') await dispatch(inc, d.event);
      else {
        await dispatch(inc, d.event, d.reason);
        await q(`INSERT INTO events(resource_id, incident_id, kind, severity, message) VALUES ($1,$2,'alert_suppressed','info',$3)`, [inc.resource_id, inc.id, `Benachrichtigung unterdrückt: ${d.reason}`]);
      }
      changed = true;
    } catch (e) {
      log.error('notification failed', { incident: inc.id, err: errMsg(e) });
    }
  }
  if (changed) { await notify('incidents'); await notify('events'); }
}
