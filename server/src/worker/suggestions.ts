import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { q, q1, notify, tx } from '../db/pool.js';
import { config } from '../lib/config.js';
import { DockerClient } from '../lib/docker.js';
import { logger, errMsg } from '../lib/log.js';
import { suggestDependencies, type ConnectionFact, type DnsFact, type HypervisorFact, type RouteFact, type SugResource, type VmFact } from '../core/suggest.js';
import { setStat } from './loops.js';

const log = logger('suggest');
let lastRun = 0;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

async function read(p: string) { try { return await readFile(p, 'utf8'); } catch { return null; } }

/** Little-endian hex IPv4 as used in /proc/net/{tcp,route}. */
export function hexToIp(h: string): string {
  const n = parseInt(h, 16);
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
}

/** Outbound ESTABLISHED IPv4 connections from /proc/<pid>/net/tcp{,6} (inbound = local port is a listener). */
export function parseTcp(tcp: string, tcp6: string): Array<{ ip: string; port: number }> {
  const rows: Array<{ local: number; remIp: string; remPort: number; st: string }> = [];
  const listeners = new Set<number>();
  const take = (text: string, v6: boolean) => {
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4) continue;
      const [, local, rem, st] = f;
      const [lh, lp] = local.split(':');
      const [rh, rp] = rem.split(':');
      const lport = parseInt(lp, 16);
      if (st === '0A') { listeners.add(lport); continue; }
      if (st !== '01') continue;
      let ip: string | null = null;
      if (!v6) ip = hexToIp(rh);
      else if (rh.startsWith('0000000000000000FFFF0000')) ip = hexToIp(rh.slice(24));
      void lh;
      if (ip) rows.push({ local: lport, remIp: ip, remPort: parseInt(rp, 16), st });
    }
  };
  take(tcp, false);
  take(tcp6, true);
  return rows.filter((r) => !listeners.has(r.local) && !r.remIp.startsWith('127.')).map((r) => ({ ip: r.remIp, port: r.remPort }));
}

function ipsOf(r: any): string[] {
  const d = r.discovered ?? {};
  return [...new Set([...(Array.isArray(d.ips) ? d.ips : []), d.ip, r.connection?.host].filter((x) => typeof x === 'string' && IPV4.test(x)))];
}

async function collectConnections(resources: any[]): Promise<ConnectionFact[]> {
  const counts = new Map<string, ConnectionFact>();
  const add = (fromId: string, ip: string, port: number) => {
    const k = `${fromId}|${ip}|${port}`;
    const c = counts.get(k);
    if (c) c.count++; else counts.set(k, { fromId, remoteIp: ip, remotePort: port, count: 1 });
  };
  const P = config.hostProc;
  const local = `unix://${config.dockerSocket}`;
  const docker = new DockerClient(local, 5000);
  const containerIps = new Set(resources.filter((r) => r.kind === 'container').flatMap(ipsOf));
  if (docker.available()) {
    for (const r of resources) {
      if (r.kind !== 'container' || (r.discovered?.docker_endpoint ?? local) !== local || !r.discovered?.container_id) continue;
      // Hermes' own worker connects to everything it monitors: that is not a dependency
      if (r.discovered.compose_project === config.composeProject && r.discovered.compose_service === 'worker') continue;
      try {
        const info = await docker.inspect(r.discovered.container_id);
        const pid = info?.State?.Pid;
        if (!pid || info?.HostConfig?.NetworkMode === 'host') continue;
        const conns = parseTcp((await read(join(P, String(pid), 'net/tcp'))) ?? '', (await read(join(P, String(pid), 'net/tcp6'))) ?? '');
        for (const c of conns) add(r.id, c.ip, c.port);
      } catch { /* container gone */ }
    }
  }
  // processes on the host itself (host network namespace = pid 1); skip docker-proxy traffic into containers
  const host = resources.find((r) => r.kind === 'host' && (r.discovered?.procfs || String(r.discovered?.docker_endpoint ?? '').startsWith('unix://')));
  if (host) {
    const conns = parseTcp((await read(join(P, '1/net/tcp'))) ?? '', (await read(join(P, '1/net/tcp6'))) ?? '');
    for (const c of conns) if (!containerIps.has(c.ip) && !/^172\.(1[6-9]|2\d|3[01])\./.test(c.ip)) add(host.id, c.ip, c.port);
  }
  return [...counts.values()];
}

async function collectRoutes(host: any): Promise<RouteFact[]> {
  const t = await read(join(config.hostProc, '1/net/route'));
  if (!t || !host) return [];
  let gateway: string | null = null;
  const subnets: string[] = [];
  for (const line of t.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || /^(docker|br-|veth|virbr|cni|flannel|cali)/.test(f[0])) continue;
    const [, dest, gw, , , , , mask] = f;
    if (dest === '00000000' && gw !== '00000000') gateway = hexToIp(gw);
    else if (gw === '00000000') {
      const bits = hexToIp(mask).split('.').reduce((a, o) => a + (Number(o).toString(2).match(/1/g)?.length ?? 0), 0);
      subnets.push(`${hexToIp(dest)}/${bits}`);
    }
  }
  return [{ hostId: host.id, gateway, subnets }];
}

async function collectDns(host: any): Promise<DnsFact[]> {
  if (!host) return [];
  const parse = (t: string | null) => (t ?? '').split('\n').map((l) => l.match(/^\s*nameserver\s+(\S+)/)?.[1]).filter((x): x is string => !!x && IPV4.test(x));
  let ns = parse(await read(join(config.hostRoot, 'etc/resolv.conf')));
  if (!ns.length || ns.every((x) => x.startsWith('127.'))) ns = parse(await read(join(config.hostRoot, 'run/systemd/resolve/resolv.conf')));
  ns = ns.filter((x) => !x.startsWith('127.'));
  return ns.length ? [{ hostId: host.id, nameservers: ns }] : [];
}

/** VMware facts from accepted resources and from candidates still waiting in the discovery inbox. */
async function collectVmware(resources: any[]): Promise<{ vms: VmFact[]; hypervisors: HypervisorFact[] }> {
  const cands = await q(`SELECT c.proposed FROM discovery_candidates c JOIN discovery_sources s ON s.id = c.source_id WHERE s.type = 'vmware' AND c.status <> 'ignored'`);
  const items = new Map<string, any>();
  for (const c of cands) items.set(c.proposed.identityKey, { key: c.proposed.identityKey, kind: c.proposed.kind, name: c.proposed.name, parent: c.proposed.parentIdentityKey ?? null, attrs: c.proposed.attributes });
  for (const r of resources) if (r.identity_key?.startsWith('vmware-')) items.set(r.identity_key, { key: r.identity_key, kind: r.kind, name: r.label, parent: r.discovered?.parent_key ?? null, attrs: r.discovered });
  const vms: VmFact[] = [], hypervisors: HypervisorFact[] = [];
  for (const i of items.values()) {
    const ds = (i.attrs?.datastores ?? []).map((d: any) => ({ name: d.name, remote_host: d.remote_host ?? null }));
    if (i.key.startsWith('vmware-vm:')) vms.push({ vmIdentity: i.key, name: i.name, ips: i.attrs?.ips ?? [], hostIdentity: i.parent, datastores: ds });
    else if (i.key.startsWith('vmware-host:')) hypervisors.push({ identity: i.key, name: i.name, ips: i.attrs?.ips ?? [], gateway: i.attrs?.gateway ?? null, datastores: ds });
  }
  return { vms, hypervisors };
}

/** Worker loop: re-analyse every 60 s or right away when a person asks for it. */
export async function suggestTick() {
  const req = await q1(`SELECT value FROM settings WHERE key = 'suggest_requested'`);
  const requested = req && new Date(req.value.at).getTime() > lastRun;
  if (!requested && Date.now() - lastRun < 60_000) return;
  lastRun = Date.now();
  const t0 = performance.now();
  const resources = await q(`SELECT id, COALESCE(display_name, name) AS label, kind, identity_key, parent_id, connection, discovered FROM resources`);
  const edges = await q(`SELECT from_id AS "from", to_id AS "to", suppressed FROM dependencies`);
  const host = resources.find((r) => r.kind === 'host' && (r.discovered?.procfs || String(r.discovered?.docker_endpoint ?? '').startsWith('unix://')));
  let connections: ConnectionFact[] = [], routes: RouteFact[] = [], dns: DnsFact[] = [], vm = { vms: [] as VmFact[], hypervisors: [] as HypervisorFact[] };
  try { connections = await collectConnections(resources); } catch (e) { log.warn('connections failed', { err: errMsg(e) }); }
  try { routes = await collectRoutes(host); dns = await collectDns(host); } catch (e) { log.warn('routing/dns failed', { err: errMsg(e) }); }
  try { vm = await collectVmware(resources); } catch (e) { log.warn('vmware facts failed', { err: errMsg(e) }); }
  const sres: SugResource[] = resources.map((r) => ({ id: r.id, label: r.label, kind: r.kind, identityKey: r.identity_key, parentId: r.parent_id, ips: ipsOf(r),
    port: Number(r.connection?.port) || null, discovered: r.discovered ?? {} }));
  const list = suggestDependencies({ resources: sres, edges, connections, routes, dns, ...vm });
  let fresh = 0;
  await tx(async (c) => {
    for (const s of list) {
      const r = await q(`INSERT INTO dependency_suggestions(key, from_id, to_id, target, type, strength, source, confidence, evidence, data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (key) DO UPDATE SET last_seen_at = now(), observations = dependency_suggestions.observations + 1, evidence = $9, data = $10, confidence = $8, target = $4
          RETURNING (xmax = 0) AS inserted, status`, [s.key, s.from, s.to, s.target, s.type, s.strength, s.source, s.confidence, s.evidence, s.data], c);
      if (r[0]?.inserted) fresh++;
    }
    // pending suggestions whose evidence vanished for a day, or that an edge now covers, go away
    await q(`DELETE FROM dependency_suggestions WHERE status = 'pending' AND last_seen_at < now() - interval '24 hours'`, [], c);
    await q(`DELETE FROM dependency_suggestions s USING dependencies d WHERE s.status = 'pending' AND s.to_id IS NOT NULL
               AND ((d.from_id = s.from_id AND d.to_id = s.to_id) OR (d.from_id = s.to_id AND d.to_id = s.from_id)) AND NOT d.suppressed`, [], c);
  });
  if (fresh || requested) await notify('suggestions');
  setStat('suggest_ms', Math.round(performance.now() - t0));
  setStat('suggest_facts', { connections: connections.length, routes: routes.length, dns: dns.length, vms: vm.vms.length, hypervisors: vm.hypervisors.length });
  if (fresh) log.info('new dependency suggestions', { fresh, total: list.length });
}
