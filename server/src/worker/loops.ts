export interface Loop { name: string; everyMs: number; fn: () => Promise<void> }

const stats: Record<string, unknown> = {};
export function setStat(k: string, v: unknown) { stats[k] = v; }
export function loopStats() { return { ...stats }; }

export const loops: Loop[] = [];
