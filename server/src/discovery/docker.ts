import { DockerClient } from '../lib/docker.js';
import type { DiscoveredItem } from '../core/types.js';
import type { DiscoveryAdapter, SourceRow } from './adapter.js';
import { config } from '../lib/config.js';

export function dockerClientFor(source: { config: Record<string, any> }) {
  return new DockerClient(source.config.endpoint || `unix://${config.dockerSocket}`);
}

/** Logical identity of a container: compose project/service survives re-creation; else the container name. */
export function containerIdentity(engine: string, c: { Names?: string[]; Labels?: Record<string, string> }): string {
  const l = c.Labels ?? {};
  const project = l['com.docker.compose.project'];
  const service = l['com.docker.compose.service'];
  if (project && service) {
    const num = Number(l['com.docker.compose.container-number'] ?? '1');
    return `docker:${engine}/compose/${project}/${service}${num > 1 ? `#${num}` : ''}`;
  }
  const name = (c.Names?.[0] ?? 'unnamed').replace(/^\//, '');
  return `docker:${engine}/name/${name}`;
}

export const dockerAdapter: DiscoveryAdapter = {
  type: 'docker',
  label: 'Docker Engine (Socket oder TCP)',
  async availability(source) {
    const d = dockerClientFor(source);
    if (!d.available()) return `Docker-Socket ${d.endpoint} ist nicht gemountet`;
    try { await d.version(); return null; } catch (e) { return `Docker API nicht erreichbar: ${(e as Error).message}`; }
  },
  async discover(source: SourceRow) {
    const d = dockerClientFor(source);
    const info = await d.info();
    const engine: string = source.config.host_name || info.Name;
    const hostKey = `host:${engine}`;
    const items: DiscoveredItem[] = [{
      identityKey: hostKey,
      kind: 'host',
      name: engine,
      attributes: {
        os: info.OperatingSystem, kernel: info.KernelVersion, arch: info.Architecture, cpus: info.NCPU, mem_total: info.MemTotal,
        docker_version: info.ServerVersion, containers_total: info.Containers, containers_running: info.ContainersRunning,
        docker_endpoint: d.endpoint,
      },
      connection: source.config.endpoint?.startsWith('tcp://') ? { host: new URL(source.config.endpoint.replace('tcp://', 'http://')).hostname } : {},
      running: true,
    }];
    const includeStopped = source.config.include_stopped !== false;
    const list = await d.containers(true);
    // map compose service name → identity for depends_on resolution
    const byService = new Map<string, string>();
    for (const c of list) {
      const l = c.Labels ?? {};
      if (l['com.docker.compose.project'] && l['com.docker.compose.service']) byService.set(`${l['com.docker.compose.project']}/${l['com.docker.compose.service']}`, containerIdentity(engine, c));
    }
    for (const c of list) {
      const labels: Record<string, string> = c.Labels ?? {};
      if (labels['hermes.ignore'] === 'true') continue;
      if (!includeStopped && c.State !== 'running') continue;
      let detail: any = null;
      try { detail = await d.inspect(c.Id); } catch { /* container vanished in between */ }
      const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
      const project = labels['com.docker.compose.project'];
      const service = labels['com.docker.compose.service'];
      const ips = Object.values<any>(c.NetworkSettings?.Networks ?? {}).map((n) => n.IPAddress).filter(Boolean).sort();
      const ports = (c.Ports ?? []).map((p: any) => ({ private: p.PrivatePort, public: p.PublicPort ?? null, type: p.Type, ip: p.IP ?? null }))
        .filter((p: any, i: number, arr: any[]) => arr.findIndex((q) => q.private === p.private && q.public === p.public && q.type === p.type) === i)
        .sort((a: any, b: any) => a.private - b.private);
      const dependsOn: string[] = [];
      const dep = labels['com.docker.compose.depends_on'];
      if (project && dep) {
        for (const part of dep.split(',')) {
          const svc = part.split(':')[0]?.trim();
          const key = svc && byService.get(`${project}/${svc}`);
          if (key) dependsOn.push(key);
        }
      }
      items.push({
        identityKey: containerIdentity(engine, c),
        kind: 'container',
        name: project && service ? `${project}/${service}${Number(labels['com.docker.compose.container-number'] ?? '1') > 1 ? '-' + labels['com.docker.compose.container-number'] : ''}` : name,
        parentIdentityKey: hostKey,
        running: c.State === 'running',
        attributes: {
          container_id: c.Id,
          container_name: name,
          image: c.Image,
          image_id: c.ImageID,
          state: c.State,
          status_text: c.Status,
          health: detail?.State?.Health?.Status ?? null,
          restart_count: detail?.RestartCount ?? null,
          restart_policy: detail?.HostConfig?.RestartPolicy?.Name ?? null,
          mem_limit: detail?.HostConfig?.Memory || null,
          cpu_limit: detail?.HostConfig?.NanoCpus ? detail.HostConfig.NanoCpus / 1e9 : null,
          started_at: detail?.State?.StartedAt ?? null,
          created: c.Created,
          ips,
          ports,
          networks: Object.keys(c.NetworkSettings?.Networks ?? {}).sort(),
          labels,
          compose_project: project ?? null,
          compose_service: service ?? null,
          compose_working_dir: labels['com.docker.compose.project.working_dir'] ?? null,
          docker_endpoint: d.endpoint,
          engine,
        },
        connection: { container_id: c.Id, container_name: name, host: ips[0] ?? null },
        dependsOn,
      });
    }
    return items;
  },
};
