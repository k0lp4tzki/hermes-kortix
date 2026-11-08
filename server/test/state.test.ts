import { describe, expect, it } from 'vitest';
import { evaluateThresholds, flapScore, resourceOwnStatus, stepState, worst, type CheckStateData } from '../src/core/state.js';
import type { State } from '../src/core/types.js';

const fresh = (): CheckStateData => ({ state: 'pending', soft_state: null, soft_count: 0, streak_started_at: null, recent_raw: [], flapping: false, flap_score: 0 });
const cfg = { fail_after: 3, recover_after: 2, hold_s: 0 };

function run(seq: State[], c = cfg, start = fresh(), stepMs = 60_000) {
  let s = start;
  const transitions: string[] = [];
  let t = Date.UTC(2026, 10, 8, 12);
  for (const raw of seq) {
    const r = stepState(s, raw, c, new Date(t));
    s = r.next;
    if (r.transition) transitions.push(`${r.transition.from}->${r.transition.to}${r.transition.recovery ? '(recovery)' : ''}`);
    t += stepMs;
  }
  return { s, transitions };
}

describe('thresholds', () => {
  it('evaluates warning and critical with operators', () => {
    const t = [{ metric: 'cpu_percent', op: '>' as const, warning: 80, critical: 95 }, { metric: 'days_remaining', op: '<' as const, warning: 14, critical: 7 }];
    expect(evaluateThresholds({ cpu_percent: 50, days_remaining: 30 }, t).state).toBe('ok');
    expect(evaluateThresholds({ cpu_percent: 85, days_remaining: 30 }, t).state).toBe('warning');
    expect(evaluateThresholds({ cpu_percent: 85, days_remaining: 3 }, t)).toMatchObject({ state: 'critical', breaches: [{ metric: 'cpu_percent', level: 'warning' }, { metric: 'days_remaining', level: 'critical' }] });
  });
  it('supports wildcard metric names (one rule for all mounts)', () => {
    const r = evaluateThresholds({ 'fs_used_percent:/': 50, 'fs_used_percent:/data': 97 }, [{ metric: 'fs_used_percent:*', op: '>', warning: 85, critical: 95 }]);
    expect(r.state).toBe('critical');
    expect(r.breaches[0].metric).toBe('fs_used_percent:/data');
  });
  it('ignores metrics that are missing (not available ≠ zero)', () => {
    expect(evaluateThresholds({}, [{ metric: 'temp', op: '>', critical: 1 }]).state).toBe('ok');
  });
});

describe('state machine', () => {
  it('confirms OK on the first result, bad states only after fail_after', () => {
    expect(run(['ok']).transitions).toEqual(['pending->ok']);
    expect(run(['critical', 'critical']).s.state).toBe('pending');
    expect(run(['critical', 'critical', 'critical']).transitions).toEqual(['pending->critical']);
  });
  it('does not alert on a single blip and needs recover_after for recovery', () => {
    const r = run(['ok', 'critical', 'ok', 'critical', 'critical', 'critical', 'ok', 'critical', 'ok', 'ok']);
    expect(r.transitions).toEqual(['pending->ok', 'ok->critical', 'critical->ok(recovery)']);
  });
  it('escalates from warning to critical after its own confirmation', () => {
    const r = run(['ok', 'warning', 'warning', 'warning', 'critical', 'critical', 'critical']);
    expect(r.transitions).toEqual(['pending->ok', 'ok->warning', 'warning->critical']);
  });
  it('respects the hold time in addition to the count', () => {
    const c = { fail_after: 1, recover_after: 1, hold_s: 150 };
    const r = run(['ok', 'critical', 'critical', 'critical', 'critical'], c);
    // streak starts at t=60s; hold of 150 s reached at the 4th critical sample (t=240s)
    expect(r.transitions).toEqual(['pending->ok', 'ok->critical']);
    expect(run(['ok', 'critical', 'critical'], c).s.state).toBe('ok');
  });
  it('detects flapping and clears it once stable', () => {
    const flappy: State[] = [];
    for (let i = 0; i < 21; i++) flappy.push(i % 2 ? 'critical' : 'ok');
    const r = run(flappy, { fail_after: 1, recover_after: 1, hold_s: 0 });
    expect(r.s.flapping).toBe(true);
    const stable = run(Array(21).fill('ok'), { fail_after: 1, recover_after: 1, hold_s: 0 }, r.s);
    expect(stable.s.flapping).toBe(false);
  });
  it('scores stable history as zero', () => {
    expect(flapScore(Array(21).fill('ok'))).toBe(0);
    expect(flapScore(['ok', 'critical'].flatMap((x) => Array(10).fill(x)).concat('critical'))).toBeLessThan(10);
  });
});

describe('aggregation', () => {
  it('orders severities critical > warning > unknown > ok', () => {
    expect(worst(['ok', 'unknown', 'warning'])).toBe('warning');
    expect(worst(['ok', 'unknown'])).toBe('unknown');
    expect(resourceOwnStatus(['pending', 'ok'])).toBe('ok');
    expect(resourceOwnStatus(['pending'])).toBe('pending');
    expect(resourceOwnStatus(['ok', 'critical', 'warning'])).toBe('critical');
  });
});
