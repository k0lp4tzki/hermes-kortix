import { describe, expect, it } from 'vitest';
import { decideNotification, selectRoutes, type IncidentNotifyState, type RoutingRule } from '../src/core/alerting.js';

const now = new Date('2026-11-08T12:00:00Z');
const inc = (p: Partial<IncidentNotifyState> = {}): IncidentNotifyState => ({ status: 'open', severity: 'critical', notified_state: null, last_notified_at: null, flapping: false, in_maintenance: false, acknowledged: false, ...p });

describe('notification decisions', () => {
  it('sends once per severity (dedup) and again on escalation', () => {
    expect(decideNotification(inc(), 0, now)).toEqual({ action: 'send', event: 'critical', newState: 'critical' });
    expect(decideNotification(inc({ notified_state: 'critical' }), 0, now)).toEqual({ action: 'none' });
    expect(decideNotification(inc({ notified_state: 'warning' }), 0, now)).toMatchObject({ action: 'send', event: 'critical' });
  });
  it('sends recovery only after a problem notification went out', () => {
    expect(decideNotification(inc({ status: 'resolved', notified_state: 'critical' }), 0, now)).toMatchObject({ action: 'send', event: 'recovery' });
    expect(decideNotification(inc({ status: 'resolved', notified_state: null }), 0, now)).toEqual({ action: 'none' });
    expect(decideNotification(inc({ status: 'resolved', notified_state: 'suppressed:critical' }), 0, now)).toEqual({ action: 'none' });
  });
  it('suppresses while flapping or in maintenance, recorded once, and sends after it ends', () => {
    const d = decideNotification(inc({ flapping: true }), 0, now);
    expect(d).toMatchObject({ action: 'suppress', reason: 'Zustand flattert', newState: 'suppressed:critical' });
    expect(decideNotification(inc({ flapping: true, notified_state: 'suppressed:critical' }), 0, now)).toEqual({ action: 'none' });
    expect(decideNotification(inc({ notified_state: 'suppressed:critical' }), 0, now)).toMatchObject({ action: 'send', event: 'critical' });
    expect(decideNotification(inc({ in_maintenance: true }), 0, now)).toMatchObject({ action: 'suppress', reason: 'Wartungsfenster' });
  });
  it('repeats reminders until acknowledged', () => {
    const old = new Date(now.getTime() - 2 * 3600_000);
    expect(decideNotification(inc({ notified_state: 'critical', last_notified_at: old }), 3600, now)).toMatchObject({ action: 'send', event: 'reminder' });
    expect(decideNotification(inc({ notified_state: 'critical', last_notified_at: old, acknowledged: true }), 3600, now)).toEqual({ action: 'none' });
    expect(decideNotification(inc({ notified_state: 'critical', last_notified_at: old }), 0, now)).toEqual({ action: 'none' });
  });
  it('never notifies for unknown', () => {
    expect(decideNotification(inc({ severity: 'unknown' }), 0, now)).toEqual({ action: 'none' });
  });
});

describe('routing', () => {
  const rule = (p: Partial<RoutingRule>): RoutingRule => ({ id: 'r', name: 'r', priority: 100, enabled: true, match: {}, channel_ids: ['c'], on_warning: true, on_critical: true, on_recovery: true, repeat_interval_s: 0, stop: false, ...p });
  const subj = { severity: 'warning' as const, resource: { id: 'x', kind: 'container', tags: ['media'], environment: 'prod', criticality: 'high', group_name: 'Medien' } };
  it('matches by severity, tags, env, criticality and stops when asked', () => {
    const rules = [
      rule({ id: 'crit-only', priority: 1, match: { min_severity: 'critical' } }),
      rule({ id: 'media', priority: 5, match: { tags: ['media'], environments: ['prod'] }, stop: true }),
      rule({ id: 'catch-all', priority: 10 }),
    ];
    expect(selectRoutes(rules, subj).map((r) => r.id)).toEqual(['media']);
    expect(selectRoutes(rules, { ...subj, severity: 'critical' }).map((r) => r.id)).toEqual(['crit-only', 'media']);
    expect(selectRoutes(rules, { ...subj, resource: { ...subj.resource, tags: [] } }).map((r) => r.id)).toEqual(['catch-all']);
  });
});
