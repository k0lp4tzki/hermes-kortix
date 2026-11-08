import type { DiscoveredItem, DiscoveryRule, RuleAction } from './types.js';

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

export function globMatch(glob: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return globToRegExp(glob).test(String(value));
}

function ipToInt(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    const v = Number(x);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** IPv4 CIDR membership. Returns false for IPv6 / malformed input. */
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** Expand an IPv4 CIDR into host addresses (network/broadcast excluded for /0-/30). */
export function expandCidr(cidr: string, max = 1024): string[] {
  const [base, bitsStr] = cidr.split('/');
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  const b = ipToInt(base);
  if (b === null || !(bits >= 0 && bits <= 32)) throw new Error(`ungültiger Netzbereich: ${cidr}`);
  const size = 2 ** (32 - bits);
  if (size > max + 2) throw new Error(`Netzbereich ${cidr} ist zu groß (${size} Adressen, erlaubt: ${max})`);
  const start = (b & (bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0)) >>> 0;
  const out: string[] = [];
  const first = size > 2 ? 1 : 0;
  const last = size > 2 ? size - 2 : size - 1;
  for (let i = first; i <= last; i++) {
    const n = start + i;
    out.push([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  return out;
}

export interface RuleContext { sourceId: string; sourceType: string }

export function ruleMatches(rule: DiscoveryRule, item: DiscoveredItem, ctx: RuleContext): boolean {
  const m = rule.match ?? {};
  const a = item.attributes ?? {};
  if (m.kinds?.length && !m.kinds.includes(item.kind)) return false;
  if (m.source_ids?.length && !m.source_ids.includes(ctx.sourceId)) return false;
  if (m.source_types?.length && !m.source_types.includes(ctx.sourceType)) return false;
  if (m.name_glob && !globMatch(m.name_glob, item.name)) return false;
  if (m.image_glob && !globMatch(m.image_glob, a.image)) return false;
  if (m.compose_project && !globMatch(m.compose_project, a.compose_project)) return false;
  if (m.labels && Object.keys(m.labels).length) {
    const labels = (a.labels ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(m.labels)) {
      if (!(k in labels)) return false;
      if (v !== '*' && !globMatch(v, labels[k])) return false;
    }
  }
  if (m.cidrs?.length) {
    const ips = ([] as string[]).concat((a.ips as string[]) ?? [], a.ip ? [String(a.ip)] : []);
    if (!ips.some((ip) => m.cidrs!.some((c) => inCidr(ip, c)))) return false;
  }
  if (m.ports?.length) {
    const ports = ((a.open_ports as number[]) ?? []).concat(((a.ports as Array<{ private?: number; public?: number }>) ?? []).flatMap((p) => [p.private ?? -1, p.public ?? -1]));
    if (!ports.some((p) => m.ports!.includes(p))) return false;
  }
  return true;
}

export interface RuleDecision { action: RuleAction; rule: DiscoveryRule | null }

/**
 * First enabled rule (lowest priority number) that matches wins. Without any matching
 * rule the safe default is "manual": the item waits in the discovery inbox.
 */
export function decide(rules: DiscoveryRule[], item: DiscoveredItem, ctx: RuleContext): RuleDecision {
  const sorted = [...rules].filter((r) => r.enabled).sort((x, y) => x.priority - y.priority);
  for (const r of sorted) if (ruleMatches(r, item, ctx)) return { action: r.action, rule: r };
  return { action: 'manual', rule: null };
}
