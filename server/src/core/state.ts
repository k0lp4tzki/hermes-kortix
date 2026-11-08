import type { State } from './types.js';

export const SEVERITY: Record<string, number> = { ok: 0, pending: 0, unknown: 1, warning: 2, critical: 3 };

export function worst(states: Array<State | string>): State {
  let w: State = 'ok';
  for (const s of states) if ((SEVERITY[s] ?? 0) > SEVERITY[w]) w = s as State;
  return w;
}

export type Op = '>' | '>=' | '<' | '<=' | '==' | '!=';
export interface Threshold { metric: string; op: Op; warning?: number | null; critical?: number | null }
export interface Breach { metric: string; value: number; level: 'warning' | 'critical'; op: Op; limit: number }

function cmp(op: Op, v: number, limit: number): boolean {
  switch (op) {
    case '>': return v > limit;
    case '>=': return v >= limit;
    case '<': return v < limit;
    case '<=': return v <= limit;
    case '==': return v === limit;
    case '!=': return v !== limit;
  }
}

/** "fs_used_percent:*" matches every mount point series. */
function metricMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}

/** Evaluates configured thresholds against the metrics of one check run. */
export function evaluateThresholds(metrics: Record<string, number>, thresholds: Threshold[]): { state: State; breaches: Breach[] } {
  const breaches: Breach[] = [];
  for (const t of thresholds ?? []) {
    for (const [name, value] of Object.entries(metrics)) {
      if (!metricMatches(t.metric, name) || typeof value !== 'number' || Number.isNaN(value)) continue;
      if (t.critical !== undefined && t.critical !== null && cmp(t.op, value, t.critical)) breaches.push({ metric: name, value, level: 'critical', op: t.op, limit: t.critical });
      else if (t.warning !== undefined && t.warning !== null && cmp(t.op, value, t.warning)) breaches.push({ metric: name, value, level: 'warning', op: t.op, limit: t.warning });
    }
  }
  return { state: worst(breaches.map((b) => b.level)), breaches };
}

export interface CheckStateData {
  state: State | 'pending';
  soft_state: State | null;
  soft_count: number;
  streak_started_at: Date | null;
  recent_raw: string[];
  flapping: boolean;
  flap_score: number;
}

export interface StateConfig { fail_after: number; recover_after: number; hold_s: number }

export interface Transition { from: State | 'pending'; to: State; recovery: boolean }

export const FLAP_WINDOW = 21;
export const FLAP_HIGH = 50;
export const FLAP_LOW = 25;

/**
 * Nagios-style flap score: share of state changes over the last results, recent changes
 * weighted more (0.8 … 1.2). Returns a percentage 0..100.
 */
export function flapScore(history: string[]): number {
  if (history.length < 2) return 0;
  const n = history.length - 1;
  let weighted = 0;
  let total = 0;
  for (let i = 1; i < history.length; i++) {
    const w = 0.8 + (0.4 * (i - 1)) / Math.max(1, n - 1);
    total += w;
    if (history[i] !== history[i - 1]) weighted += w;
  }
  return (weighted / total) * 100 * (n / (FLAP_WINDOW - 1));
}

/**
 * One step of the check state machine (soft/hard states with hysteresis).
 * - a new bad state becomes hard after `fail_after` consecutive results AND `hold_s` seconds
 * - recovery to OK needs `recover_after` consecutive OK results
 * - the first result of a new check confirms OK immediately; bad states still need confirmation
 */
export function stepState(prev: CheckStateData, raw: State, cfg: StateConfig, now: Date): { next: CheckStateData; transition: Transition | null; flappingChanged: boolean } {
  const next: CheckStateData = { ...prev, recent_raw: [...prev.recent_raw, raw].slice(-FLAP_WINDOW) };
  if (prev.soft_state === raw) next.soft_count = prev.soft_count + 1;
  else { next.soft_state = raw; next.soft_count = 1; next.streak_started_at = now; }

  let transition: Transition | null = null;
  if (raw !== prev.state) {
    if (raw === 'ok') {
      if (prev.state === 'pending' || next.soft_count >= cfg.recover_after) transition = { from: prev.state, to: 'ok', recovery: prev.state !== 'pending' };
    } else {
      const heldFor = next.streak_started_at ? (now.getTime() - next.streak_started_at.getTime()) / 1000 : 0;
      if (next.soft_count >= cfg.fail_after && heldFor >= cfg.hold_s) transition = { from: prev.state, to: raw, recovery: false };
    }
  }
  if (transition) next.state = transition.to;

  const score = flapScore(next.recent_raw);
  next.flap_score = Math.round(score * 10) / 10;
  const wasFlapping = prev.flapping;
  if (!wasFlapping && score >= FLAP_HIGH) next.flapping = true;
  else if (wasFlapping && score < FLAP_LOW) next.flapping = false;
  return { next, transition, flappingChanged: next.flapping !== wasFlapping };
}

/** Resource status from its own enabled checks. */
export function resourceOwnStatus(checkStates: string[]): State | 'pending' {
  const real = checkStates.filter((s) => s !== 'pending');
  if (real.length === 0) return 'pending';
  return worst(real);
}
