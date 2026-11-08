import { Socket } from 'node:net';
import { reverse } from 'node:dns/promises';
import type { DiscoveredItem } from '../core/types.js';
import type { DiscoveryAdapter } from './adapter.js';
import { expandCidr, inCidr } from '../core/rules.js';

export const DEFAULT_SCAN_PORTS = [22, 53, 80, 443, 445, 3000, 3306, 5432, 6379, 8006, 8080, 8443, 9000, 9090];

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host);
  });
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

/**
 * Opt-in TCP connect scan of configured IPv4 ranges. Safe defaults: disabled until a person
 * enters ranges, max 1024 addresses per range, short timeouts, limited parallelism, exclude list.
 */
export const networkAdapter: DiscoveryAdapter = {
  type: 'network',
  label: 'Netzwerkbereich (TCP-Port-Scan)',
  async availability(source) {
    if (!Array.isArray(source.config.cidrs) || source.config.cidrs.length === 0) return 'keine Netzbereiche konfiguriert';
    return null;
  },
  async discover(source) {
    const cidrs: string[] = source.config.cidrs ?? [];
    const exclude: string[] = source.config.exclude ?? [];
    const ports: number[] = source.config.ports?.length ? source.config.ports : DEFAULT_SCAN_PORTS;
    const timeout = Math.min(Number(source.config.timeout_ms ?? 400), 3000);
    const hosts = cidrs.flatMap((c) => expandCidr(c, 1024)).filter((ip) => !exclude.some((e) => inCidr(ip, e.includes('/') ? e : `${e}/32`)));
    const results = await pool(hosts, 64, async (ip) => {
      const open: number[] = [];
      for (const p of ports) if (await probe(ip, p, timeout)) open.push(p);
      return { ip, open };
    });
    const items: DiscoveredItem[] = [];
    for (const r of results) {
      if (!r.open.length) continue;
      let rdns: string | null = null;
      try { rdns = (await reverse(r.ip))[0] ?? null; } catch { /* no PTR */ }
      items.push({
        identityKey: `net:${r.ip}`, kind: 'endpoint', name: rdns ?? r.ip, running: true,
        attributes: { ip: r.ip, ips: [r.ip], open_ports: r.open, rdns },
        connection: { host: r.ip },
      });
    }
    return items;
  },
};
