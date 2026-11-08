import { q } from '../db/pool.js';
import { config } from '../lib/config.js';
import { selectRoutes, type RoutingRule } from '../core/alerting.js';
import { sendWebhook } from './webhook.js';
import { logger } from '../lib/log.js';

const log = logger('alerting');
const publicUrl = process.env.HERMES_PUBLIC_URL?.replace(/\/$/, '') ?? '';

export async function buildPayload(incident: any, event: string) {
  const res = (await q(`SELECT id, name, COALESCE(display_name, name) AS label, kind, criticality, environment, group_name, tags, status, status_message,
      (SELECT name FROM resources p WHERE p.id = r.parent_id) AS host FROM resources r WHERE id = $1`, [incident.resource_id]))[0];
  const impacted = incident.affected_ids?.length ? await q(`SELECT id, COALESCE(display_name, name) AS name, kind, status FROM resources WHERE id = ANY($1)`, [incident.affected_ids]) : [];
  const symptoms = incident.suppressed_ids?.length ? await q(`SELECT id, COALESCE(display_name, name) AS name, kind, status FROM resources WHERE id = ANY($1)`, [incident.suppressed_ids]) : [];
  const checks = await q(`SELECT name, type, state, last_message AS message FROM checks WHERE resource_id = $1 AND enabled AND state <> 'ok'`, [incident.resource_id]);
  const end = incident.resolved_at ? new Date(incident.resolved_at) : new Date();
  return {
    version: 1,
    source: 'hermes',
    event,
    dedup_key: `hermes:incident:${incident.id}`,
    timestamp: new Date().toISOString(),
    message: event === 'recovery' ? `Behoben: ${incident.title}` : `${event === 'reminder' ? 'Erinnerung: ' : ''}[${String(incident.severity).toUpperCase()}] ${incident.title}`,
    incident: {
      id: incident.id, status: incident.status, severity: incident.severity, peak_severity: incident.peak_severity, title: incident.title,
      opened_at: incident.opened_at, resolved_at: incident.resolved_at, duration_s: Math.round((end.getTime() - new Date(incident.opened_at).getTime()) / 1000),
      occurrences_7d: incident.occurrences_7d, flapping: incident.flapping, acknowledged_by: incident.acknowledged_by,
      url: publicUrl ? `${publicUrl}/alerts?incident=${incident.id}` : null,
    },
    resource: res ? { id: res.id, name: res.label, kind: res.kind, host: res.host, criticality: res.criticality, environment: res.environment, group: res.group_name, tags: res.tags, status: res.status } : null,
    root_cause: res ? { id: res.id, name: res.label } : null,
    impacted,
    suppressed_symptoms: symptoms,
    checks,
    compose_project: config.composeProject,
  };
}

/** Routes one notification event of an incident to the matching channels and logs every attempt. */
export async function dispatch(incident: any, event: 'warning' | 'critical' | 'recovery' | 'reminder', suppressReason?: string): Promise<number> {
  const resource = (await q(`SELECT id, kind, tags, environment, criticality, group_name FROM resources WHERE id = $1`, [incident.resource_id]))[0];
  if (!resource) return 0;
  const rules = await q<RoutingRule>(`SELECT * FROM routing_rules`);
  const sev = event === 'recovery' || event === 'reminder' ? incident.severity : event;
  const routes = selectRoutes(rules, { severity: sev, resource });
  let sent = 0;
  const payload = await buildPayload(incident, event);
  for (const rule of routes) {
    const wanted = event === 'recovery' ? rule.on_recovery : sev === 'critical' ? rule.on_critical : rule.on_warning;
    if (!wanted) continue;
    for (const chId of rule.channel_ids) {
      const ch = (await q(`SELECT * FROM notification_channels WHERE id = $1`, [chId]))[0];
      if (!ch) continue;
      const dedup = `${incident.id}:${event}:${incident.severity}`;
      if (suppressReason || !ch.enabled) {
        await q(`INSERT INTO notifications(incident_id, channel_id, rule_id, event, status, reason, dedup_key, payload) VALUES ($1,$2,$3,$4,'suppressed',$5,$6,$7)`,
          [incident.id, ch.id, rule.id, event, suppressReason ?? 'Kanal deaktiviert', dedup, payload]);
        continue;
      }
      const r = await sendWebhook(ch, payload);
      await q(`INSERT INTO notifications(incident_id, channel_id, rule_id, event, status, reason, http_status, duration_ms, dedup_key, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [incident.id, ch.id, rule.id, event, r.ok ? 'sent' : 'failed', r.error, r.status, r.durationMs, dedup, payload]);
      await q(`UPDATE notification_channels SET last_status = $2, last_sent_at = now() WHERE id = $1`, [ch.id, r.ok ? 'ok' : r.error]);
      await q(`INSERT INTO events(resource_id, incident_id, kind, severity, message) VALUES ($1,$2,$3,$4,$5)`, [incident.resource_id, incident.id, r.ok ? 'alert_sent' : 'alert_failed',
        r.ok ? 'info' : 'warning', `${r.ok ? 'Benachrichtigung' : 'Benachrichtigung FEHLGESCHLAGEN'} (${event}) an „${ch.name}“ über Regel „${rule.name}“${r.ok ? '' : ': ' + r.error}`]);
      if (r.ok) sent++;
      else log.warn('webhook failed', { channel: ch.name, err: r.error });
    }
  }
  return sent;
}
