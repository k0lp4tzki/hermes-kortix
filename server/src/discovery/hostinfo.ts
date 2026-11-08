import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config.js';

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
  const ips = new Set<string>();
  const lines = t.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('/32 host LOCAL')) {
      const m = lines[i - 1].match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m && !m[1].startsWith('127.')) ips.add(m[1]);
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
