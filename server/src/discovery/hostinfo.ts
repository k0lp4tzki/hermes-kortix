import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config.js';
import { inCidr } from '../core/rules.js';

export async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

/** Hostname of the machine Hermes runs on (not of the container). */
export async function hostName(): Promise<string> {
  if (config.hostName) return config.hostName;
  const h = (await readText(join(config.hostRoot, 'etc/hostname')))?.trim();
  if (h) return h;
  const p = (await readText(join(config.hostProc, 'sys/kernel/hostname')))?.trim();
  return p || 'docker-host';
}

export function hostProcAvailable() { return existsSync(join(config.hostProc, 'stat')); }

export async function osRelease(): Promise<string | null> {
  const t = await readText(join(config.hostRoot, 'etc/os-release'));
  if (!t) return null;
  const m = t.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  return m ? m[1] : null;
}

/** IPv4 addresses of the host network namespace (via pid 1's view of /proc/net/fib_trie). */
export async function hostIps(): Promise<string[]> {
  const t = await readText(join(config.hostProc, '1/net/fib_trie'));
  if (!t) return [];
  // addresses on docker/libvirt/CNI bridges are the same on every docker host: not an identity of this machine
  const bridgeNets: string[] = [];
  for (const line of ((await readText(join(config.hostProc, '1/net/route'))) ?? '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || !/^(docker|br-|veth|virbr|cni|flannel|cali|vxlan|kube)/.test(f[0]) || f[2] !== '00000000') continue;
    const hex = (h: string) => { const n = parseInt(h, 16); return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.'); };
    const bits = hex(f[7]).split('.').reduce((a, o) => a + (Number(o).toString(2).match(/1/g)?.length ?? 0), 0);
    bridgeNets.push(`${hex(f[1])}/${bits}`);
  }
  const ips = new Set<string>();
  const lines = t.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('/32 host LOCAL')) {
      const m = lines[i - 1].match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m && !m[1].startsWith('127.') && !bridgeNets.some((n) => inCidr(m[1], n))) ips.add(m[1]);
    }
  }
  return [...ips].sort();
}

export async function activeSystemdUnits(): Promise<string[] | null> {
  const dir = join(config.hostRoot, 'run/systemd/units');
  if (!existsSync(dir)) return null;
  try {
    return (await readdir(dir)).filter((f) => f.startsWith('invocation:')).map((f) => f.slice('invocation:'.length));
  } catch {
    return null;
  }
}
