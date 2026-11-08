import http from 'node:http';
import https from 'node:https';
import { existsSync } from 'node:fs';

/**
 * Minimal Docker Engine API client (read-only calls only) over a unix socket or TCP.
 * endpoint: "unix:///var/run/docker.sock" | "tcp://10.0.0.5:2375" | "https://host:2376"
 */
export class DockerClient {
  private socketPath?: string;
  private base?: URL;

  constructor(public endpoint: string, private timeoutMs = 10_000) {
    if (endpoint.startsWith('unix://')) this.socketPath = endpoint.slice('unix://'.length);
    else this.base = new URL(endpoint.replace(/^tcp:\/\//, 'http://'));
  }

  available(): boolean {
    return this.socketPath ? existsSync(this.socketPath) : true;
  }

  private request(path: string, raw = false): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const opts: http.RequestOptions = this.socketPath
        ? { socketPath: this.socketPath, path, method: 'GET', headers: { Host: 'docker' } }
        : { host: this.base!.hostname, port: this.base!.port || (this.base!.protocol === 'https:' ? 2376 : 2375), path, method: 'GET' };
      const mod = this.base?.protocol === 'https:' ? https : http;
      const req = mod.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`Docker API timeout after ${this.timeoutMs} ms (${path})`)));
      req.on('error', reject);
      req.end();
      void raw;
    });
  }

  async get<T = any>(path: string): Promise<T> {
    const r = await this.request(path);
    if (r.status >= 400) throw new Error(`Docker API ${path}: HTTP ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
    return JSON.parse(r.body.toString('utf8')) as T;
  }

  info() { return this.get('/info'); }
  version() { return this.get('/version'); }
  containers(all = true) { return this.get<any[]>(`/containers/json?all=${all ? 1 : 0}`); }
  inspect(id: string) { return this.get(`/containers/${encodeURIComponent(id)}/json`); }
  stats(id: string) { return this.get(`/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=false`); }

  /** Container log lines since a unix timestamp (stdout+stderr, demultiplexed when not a TTY). */
  async logs(id: string, sinceUnix: number, tail = 2000): Promise<string[]> {
    const r = await this.request(`/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&since=${Math.floor(sinceUnix)}&tail=${tail}&timestamps=0`);
    if (r.status >= 400) throw new Error(`Docker logs: HTTP ${r.status}`);
    return demux(r.body).split('\n').filter((l) => l.length > 0);
  }
}

/** Docker multiplexes stdout/stderr with 8-byte frame headers unless the container has a TTY. */
export function demux(buf: Buffer): string {
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    const parts: Buffer[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i + 4);
      parts.push(buf.subarray(i + 8, i + 8 + len));
      i += 8 + len;
    }
    return Buffer.concat(parts).toString('utf8');
  }
  return buf.toString('utf8');
}

/** CPU % and memory figures from one /stats sample (same formula as `docker stats`). */
export function computeContainerStats(s: any) {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus ?? s.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  const cpuPercent = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * cpus * 100 : null;
  const usage = s.memory_stats?.usage;
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.total_inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
  const memUsed = typeof usage === 'number' ? Math.max(0, usage - cache) : null;
  const memLimit = s.memory_stats?.limit ?? null;
  let rx = 0, tx = 0, rxErr = 0, txErr = 0;
  for (const n of Object.values<any>(s.networks ?? {})) { rx += n.rx_bytes ?? 0; tx += n.tx_bytes ?? 0; rxErr += n.rx_errors ?? 0; txErr += n.tx_errors ?? 0; }
  let blkRead = 0, blkWrite = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (/read/i.test(e.op)) blkRead += e.value;
    if (/write/i.test(e.op)) blkWrite += e.value;
  }
  return { cpuPercent, memUsed, memLimit, rx, tx, rxErr, txErr, blkRead, blkWrite, pids: s.pids_stats?.current ?? null, hasNetworks: !!s.networks };
}
