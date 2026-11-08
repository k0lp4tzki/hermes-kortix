import { q, type Queryable } from '../db/pool.js';
import type { DiscoveredItem } from '../core/types.js';
import { executors } from './registry.js';

interface Tpl { type: string; name: string; config?: Record<string, unknown>; enabled?: boolean; interval_s?: number; thresholds?: unknown[] }

/** Sensible default checks per resource kind for things discovery found. Only real data sources. */
export function templatesFor(item: Pick<DiscoveredItem, 'kind' | 'attributes' | 'connection'>): Tpl[] {
  const a = item.attributes ?? {};
  switch (item.kind) {
    case 'container':
      return [
        { type: 'container', name: 'Container-Zustand & Ressourcen' },
        { type: 'container_logs', name: 'Container-Logs: Fehler', thresholds: [{ metric: 'error_lines', op: '>', warning: 5, critical: null }] },
      ];
    case 'host':
      // the machine Hermes runs on (found via /proc or the local docker socket) gets host metrics
      return a.procfs || String(a.docker_endpoint ?? '').startsWith('unix://') ? [{ type: 'host', name: 'Host-Ressourcen' }] : [{ type: 'ping', name: 'Ping' }];
    case 'systemd_service':
      return [{ type: 'systemd_unit', name: 'Dienst aktiv', config: { unit: a.unit } }];
    case 'endpoint': {
      const ports = ((a.open_ports as number[]) ?? []).slice(0, 6);
      const out: Tpl[] = [{ type: 'ping', name: 'Ping' }];
      for (const p of ports) {
        if (p === 22) out.push({ type: 'ssh', name: 'SSH', config: { port: 22 } });
        else if (p === 443 || p === 8443) { out.push({ type: 'http', name: `HTTPS :${p}`, config: { url: `https://${a.ip}:${p}/`, tls_verify: false, expected_status: '200-499' } }); out.push({ type: 'tls', name: `TLS-Zertifikat :${p}`, config: { port: p, allow_untrusted: true } }); }
        else if ([80, 8080, 3000, 9000, 9090, 8006].includes(p)) out.push({ type: 'http', name: `HTTP :${p}`, config: { url: `http://${a.ip}:${p}/`, expected_status: '200-499' } });
        else out.push({ type: 'tcp', name: `TCP :${p}`, config: { port: p } });
      }
      return out;
    }
    case 'platform':
      return [{ type: 'platform', name: 'Selbstüberwachung' }];
    default:
      return [];
  }
}

export async function createChecks(db: Queryable, resourceId: string, tpls: Tpl[], origin: 'auto' | 'manual' = 'auto') {
  for (const t of tpls) {
    const ex = executors[t.type];
    if (!ex) continue;
    await q(`INSERT INTO checks(resource_id, type, name, config, interval_s, enabled, thresholds, origin, template, next_run)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$2, now() + (random() * interval '10 seconds'))`,
      [resourceId, t.type, t.name, t.config ?? {}, t.interval_s ?? ex.defaultInterval, t.enabled ?? true, JSON.stringify(t.thresholds ?? ex.defaultThresholds), origin], db);
  }
}

export async function defaultChecksHook(db: Queryable, resourceId: string, item: DiscoveredItem) {
  await createChecks(db, resourceId, templatesFor(item));
}
