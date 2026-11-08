/** Pure alert routing and notification decisions (dedup, flapping, maintenance, reminders, recovery). */

export interface RouteMatch {
  min_severity?: 'warning' | 'critical';
  kinds?: string[];
  tags?: string[];
  environments?: string[];
  criticalities?: string[];
  groups?: string[];
  resource_ids?: string[];
}

export interface RoutingRule {
  id: string; name: string; priority: number; enabled: boolean; match: RouteMatch; channel_ids: string[];
  on_warning: boolean; on_critical: boolean; on_recovery: boolean; repeat_interval_s: number; stop: boolean;
}

export interface AlertSubject {
  severity: 'warning' | 'critical' | 'unknown';
  resource: { id: string; kind: string; tags: string[]; environment: string | null; criticality: string; group_name: string | null };
}

const RANK: Record<string, number> = { unknown: 0, warning: 1, critical: 2 };

export function routeMatches(rule: RoutingRule, s: AlertSubject): boolean {
  const m = rule.match ?? {};
  const r = s.resource;
  if (m.min_severity && (RANK[s.severity] ?? 0) < RANK[m.min_severity]) return false;
  if (m.kinds?.length && !m.kinds.includes(r.kind)) return false;
  if (m.tags?.length && !r.tags.some((t) => m.tags!.includes(t))) return false;
  if (m.environments?.length && !m.environments.includes(r.environment ?? '')) return false;
  if (m.criticalities?.length && !m.criticalities.includes(r.criticality)) return false;
  if (m.groups?.length && !m.groups.includes(r.group_name ?? '')) return false;
  if (m.resource_ids?.length && !m.resource_ids.includes(r.id)) return false;
  return true;
}

/** Rules that apply, in priority order, honouring "stop". */
export function selectRoutes(rules: RoutingRule[], s: AlertSubject): RoutingRule[] {
  const out: RoutingRule[] = [];
  for (const r of [...rules].filter((x) => x.enabled).sort((a, b) => a.priority - b.priority)) {
    if (!routeMatches(r, s)) continue;
    out.push(r);
    if (r.stop) break;
  }
  return out;
}

export interface IncidentNotifyState {
  status: 'open' | 'resolved';
  severity: 'warning' | 'critical' | 'unknown';
  notified_state: string | null;   // 'warning' | 'critical' | 'suppressed:<sev>' | null
  last_notified_at: Date | null;
  flapping: boolean;
  in_maintenance: boolean;
  acknowledged: boolean;
}

export type NotifyDecision =
  | { action: 'none' }
  | { action: 'send'; event: 'warning' | 'critical' | 'recovery' | 'reminder'; newState: string | null }
  | { action: 'suppress'; event: 'warning' | 'critical' | 'recovery'; reason: string; newState: string | null };

/**
 * What to do for an incident now. Dedup: one notification per severity level; escalation and
 * de-escalation notify again; recovery only if a problem notification actually went out.
 * Flapping and maintenance suppress (recorded once), reminders repeat while unacknowledged.
 */
export function decideNotification(i: IncidentNotifyState, repeatIntervalS: number, now: Date): NotifyDecision {
  if (i.status === 'resolved') {
    if (i.notified_state === 'warning' || i.notified_state === 'critical') {
      if (i.in_maintenance) return { action: 'suppress', event: 'recovery', reason: 'Wartungsfenster', newState: null };
      return { action: 'send', event: 'recovery', newState: null };
    }
    return { action: 'none' };
  }
  if (i.severity === 'unknown') return { action: 'none' };
  const sev = i.severity;
  if (i.notified_state === sev) {
    if (repeatIntervalS > 0 && !i.acknowledged && !i.flapping && !i.in_maintenance && i.last_notified_at && now.getTime() - i.last_notified_at.getTime() >= repeatIntervalS * 1000) {
      return { action: 'send', event: 'reminder', newState: sev };
    }
    return { action: 'none' };
  }
  if (i.flapping || i.in_maintenance) {
    const marker = `suppressed:${sev}`;
    if (i.notified_state === marker) return { action: 'none' };
    return { action: 'suppress', event: sev, reason: i.flapping ? 'Zustand flattert' : 'Wartungsfenster', newState: marker };
  }
  return { action: 'send', event: sev, newState: sev };
}
