import { discoveryTick } from '../discovery/engine.js';
import { schedulerTick } from './scheduler.js';
import { evaluateTick } from './evaluate.js';
import { pruneTick } from './retention.js';

export interface Loop { name: string; everyMs: number; fn: () => Promise<void> }

const stats: Record<string, unknown> = {};
export function setStat(k: string, v: unknown) { stats[k] = v; }
export function loopStats() { return { ...stats }; }

export const loops: Loop[] = [
  { name: 'scheduler', everyMs: 500, fn: schedulerTick },
  { name: 'evaluate', everyMs: 2000, fn: evaluateTick },
  { name: 'discovery', everyMs: 2000, fn: discoveryTick },
  { name: 'prune', everyMs: 3600_000, fn: pruneTick },
];
