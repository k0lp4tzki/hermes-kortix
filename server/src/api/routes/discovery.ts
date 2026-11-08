import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notify, q, q1, tx } from '../../db/pool.js';
import { decide, ruleMatches, expandCidr } from '../../core/rules.js';
import type { DiscoveredItem, DiscoveryRule } from '../../core/types.js';
import { acceptItem, syncAutoStructure } from '../../discovery/accept.js';
import { audit, HttpError, requireRole } from '../auth.js';
import { notFound, parse } from '../util.js';
import { testVsphere } from '../../discovery/vmware.js';
import { unseal } from '../../lib/crypto.js';

const ruleBody = z.object({
  name: z.string().min(1).max(200),
  priority: z.number().int().min(0).max(100000).default(100),
  enabled: z.boolean().default(true),
  match: z.object({
    kinds: z.array(z.string()).optional(),
    source_ids: z.array(z.string().uuid()).optional(),
    source_types: z.array(z.string()).optional(),
    name_glob: z.string().max(200).optional(),
    image_glob: z.string().max(200).optional(),
    compose_project: z.string().max(200).optional(),
    labels: z.record(z.string()).optional(),
    cidrs: z.array(z.string().regex(/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/)).optional(),
    ports: z.array(z.number().int().min(1).max(65535)).optional(),
  }).default({}),
  action: z.enum(['auto_accept', 'ignore', 'manual']),
  enable_monitoring: z.boolean().default(false),
  set: z.object({ environment: z.string().optional(), group_name: z.string().optional(), criticality: z.enum(['low', 'medium', 'high', 'critical']).optional(), owner: z.string().optional(), tags: z.array(z.string()).optional() }).default({}),
});

const sourceBody = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['docker', 'host', 'network', 'vmware']),
  config: z.record(z.any()).default({}),
  enabled: z.boolean().default(true),
  interval_s: z.number().int().min(10).max(86400 * 7).default(60),
  orphan_after_s: z.number().int().min(60).max(86400 * 90).default(86400),
});

function validateSourceConfig(type: string, cfg: Record<string, any>) {
  if (type === 'docker' && cfg.endpoint && !/^(unix:\/\/\/|tcp:\/\/|https?:\/\/)/.test(cfg.endpoint)) throw new HttpError(400, 'Docker-Endpunkt muss mit unix:///, tcp:// oder https:// beginnen');
  if (type === 'vmware') {
    if (!cfg.url || !/^(https?:\/\/)?[a-zA-Z0-9.\-:\[\]]+(\/.*)?$/.test(cfg.url)) throw new HttpError(400, 'Adresse des ESXi/vCenter fehlt oder ist ungültig');
    if (!cfg.username) throw new HttpError(400, 'Benutzer fehlt');
    if (!cfg.secret_id) throw new HttpError(400, 'Zugangsdaten (Passwort) wählen');
  }
  if (type === 'network') {
    for (const c of cfg.cidrs ?? []) expandCidrSafe(c);
    if (cfg.ports && (!Array.isArray(cfg.ports) || cfg.ports.some((p: unknown) => !Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535))) throw new HttpError(400, 'Ports müssen ganze Zahlen 1–65535 sein');
  }
}
function expandCidrSafe(c: string) {
  try { expandCidr(c, 1024); } catch (e) { throw new HttpError(400, (e as Error).message); }
}

async function sourceCtx(sourceId: string) {
  const s = await q1(`SELECT id, type FROM discovery_sources WHERE id = $1`, [sourceId]);
  return { sourceId, sourceType: s?.type ?? 'unknown' };
}

export default async function discoveryRoutes(app: FastifyInstance) {
  app.get('/api/discovery/sources', async () => q(`SELECT s.*,
      (SELECT count(*)::int FROM resources r WHERE r.source_id = s.id) AS resource_count,
      (SELECT count(*)::int FROM discovery_candidates c WHERE c.source_id = s.id AND c.status = 'pending') AS pending_count
    FROM discovery_sources s ORDER BY s.system DESC, s.name`));

  app.post('/api/discovery/sources', async (req) => {
    requireRole(req, 'operator');
    const b = parse(sourceBody, req.body);
    validateSourceConfig(b.type, b.config);
    const row = await q1(`INSERT INTO discovery_sources(name, type, config, enabled, interval_s, orphan_after_s) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.name, b.type, b.config, b.enabled, b.interval_s, b.orphan_after_s]);
    await audit(req, 'discovery.source_created', b.name, { type: b.type });
    return row;
  });

  app.patch('/api/discovery/sources/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const b = parse(sourceBody.partial(), req.body);
    const cur = await q1(`SELECT * FROM discovery_sources WHERE id = $1`, [id]);
    if (!cur) notFound('Quelle');
    if (b.config) validateSourceConfig(cur.type, b.config);
    const row = await q1(`UPDATE discovery_sources SET name = COALESCE($2, name), config = COALESCE($3, config), enabled = COALESCE($4, enabled),
      interval_s = COALESCE($5, interval_s), orphan_after_s = COALESCE($6, orphan_after_s) WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.config ?? null, b.enabled ?? null, b.interval_s ?? null, b.orphan_after_s ?? null]);
    await audit(req, 'discovery.source_updated', cur.name, b);
    return row;
  });

  app.delete('/api/discovery/sources/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const s = await q1(`DELETE FROM discovery_sources WHERE id = $1 AND NOT system RETURNING name`, [id]);
    if (!s) throw new HttpError(400, 'Quelle nicht gefunden oder systemeigen (nur deaktivierbar)');
    await audit(req, 'discovery.source_deleted', s.name);
    return { ok: true };
  });

  /** Connection test for a VMware source (draft config, nothing is stored). */
  app.post('/api/discovery/vmware/test', async (req) => {
    requireRole(req, 'operator');
    const b = parse(z.object({ url: z.string().min(1), username: z.string().min(1), secret_id: z.string().uuid(), allow_untrusted: z.boolean().default(true) }), req.body);
    const s = await q1(`SELECT ciphertext, iv, auth_tag FROM secrets WHERE id = $1`, [b.secret_id]);
    if (!s) notFound('Zugangsdaten');
    try {
      return await testVsphere(b, unseal({ ciphertext: s.ciphertext, iv: s.iv, authTag: s.auth_tag }));
    } catch (e) {
      const err = e as any;
      return { ok: false, error: `${err.cause?.code ?? err.code ?? ''} ${err.cause?.message ?? err.message}`.trim() };
    }
  });

  app.post('/api/discovery/sources/:id/run', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const s = await q1(`UPDATE discovery_sources SET run_requested_at = now() WHERE id = $1 RETURNING name`, [id]);
    if (!s) notFound('Quelle');
    return { ok: true, message: `Lauf von „${s.name}“ angefordert` };
  });

  app.get('/api/discovery/candidates', async (req) => {
    const { status } = req.query as { status?: string };
    return q(`SELECT c.*, s.name AS source_name, s.type AS source_type, r.name AS rule_name,
        (SELECT COALESCE(p.display_name, p.name) FROM resources p WHERE p.identity_key = c.parent_identity_key) AS parent_name
      FROM discovery_candidates c JOIN discovery_sources s ON s.id = c.source_id LEFT JOIN discovery_rules r ON r.id = c.rule_id
      WHERE ($1::text IS NULL OR c.status = $1) ORDER BY c.status, c.kind, c.name LIMIT 2000`, [status ?? null]);
  });

  const decideBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), enable_monitoring: z.boolean().default(false),
    set: ruleBody.shape.set.optional(), create_rule: z.boolean().default(false) });

  app.post('/api/discovery/candidates/approve', async (req) => {
    requireRole(req, 'operator');
    const b = parse(decideBody, req.body);
    const created: string[] = [];
    await tx(async (c) => {
      // parents first (a host before its containers)
      const cands = await q(`SELECT * FROM discovery_candidates WHERE id = ANY($1) AND status <> 'accepted' ORDER BY (parent_identity_key IS NOT NULL), name`, [b.ids], c);
      for (const cand of cands) {
        created.push(await acceptItem(c, cand.proposed as DiscoveredItem, { sourceId: cand.source_id, enableMonitoring: b.enable_monitoring, set: b.set, actor: req.user!.username }));
      }
      await syncAutoStructure(c);
    });
    await audit(req, 'discovery.approved', `${created.length} Kandidaten`, { monitoring: b.enable_monitoring });
    await notify('discovery');
    return { ok: true, created };
  });

  app.post('/api/discovery/candidates/ignore', async (req) => {
    requireRole(req, 'operator');
    const b = parse(decideBody, req.body);
    const rows = await q(`UPDATE discovery_candidates SET status = 'ignored', decided_at = now(), decided_by = $2 WHERE id = ANY($1) AND status = 'pending' RETURNING *`, [b.ids, req.user!.username]);
    if (b.create_rule) {
      // a persistent deny entry per identity so re-discovery never asks again
      for (const r of rows) {
        await q(`INSERT INTO discovery_rules(name, priority, match, action) VALUES ($1, 50, $2, 'ignore')`, [`Ignorieren: ${r.name}`, { kinds: [r.kind], name_glob: r.name, source_ids: [r.source_id] }]);
      }
    }
    await audit(req, 'discovery.ignored', `${rows.length} Kandidaten`, { create_rule: b.create_rule });
    await notify('discovery');
    return { ok: true, count: rows.length };
  });

  app.post('/api/discovery/candidates/reset', async (req) => {
    requireRole(req, 'operator');
    const b = parse(z.object({ ids: z.array(z.string().uuid()).min(1) }), req.body);
    await q(`UPDATE discovery_candidates SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = ANY($1) AND status = 'ignored'`, [b.ids]);
    await notify('discovery');
    return { ok: true };
  });

  app.get('/api/discovery/rules', async () => q(`SELECT * FROM discovery_rules ORDER BY priority, name`));

  app.post('/api/discovery/rules', async (req) => {
    requireRole(req, 'operator');
    const b = parse(ruleBody, req.body);
    const row = await q1(`INSERT INTO discovery_rules(name, priority, enabled, match, action, enable_monitoring, set) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.name, b.priority, b.enabled, b.match, b.action, b.enable_monitoring, b.set]);
    await audit(req, 'discovery.rule_created', b.name, b);
    return row;
  });

  app.put('/api/discovery/rules/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const b = parse(ruleBody, req.body);
    const row = await q1(`UPDATE discovery_rules SET name=$2, priority=$3, enabled=$4, match=$5, action=$6, enable_monitoring=$7, set=$8 WHERE id=$1 RETURNING *`,
      [id, b.name, b.priority, b.enabled, b.match, b.action, b.enable_monitoring, b.set]);
    if (!row) notFound('Regel');
    await audit(req, 'discovery.rule_updated', b.name, b);
    return row;
  });

  app.delete('/api/discovery/rules/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const r = await q1(`DELETE FROM discovery_rules WHERE id = $1 RETURNING name`, [id]);
    if (!r) notFound('Regel');
    await audit(req, 'discovery.rule_deleted', r.name);
    return { ok: true };
  });

  /** Preview: which pending/ignored candidates a (draft) rule would match. Nothing is changed. */
  app.post('/api/discovery/rules/preview', async (req) => {
    const b = parse(ruleBody, req.body);
    const cands = await q(`SELECT c.id, c.name, c.kind, c.status, c.source_id, c.proposed, s.type AS source_type FROM discovery_candidates c JOIN discovery_sources s ON s.id = c.source_id WHERE c.status <> 'accepted'`);
    const rule: DiscoveryRule = { id: 'preview', ...b } as DiscoveryRule;
    return cands.filter((c) => ruleMatches(rule, c.proposed, { sourceId: c.source_id, sourceType: c.source_type }))
      .map((c) => ({ id: c.id, name: c.name, kind: c.kind, status: c.status }));
  });

  /** Apply the current rules to everything waiting in the inbox. */
  app.post('/api/discovery/rules/apply', async (req) => {
    requireRole(req, 'operator');
    const rules = await q<DiscoveryRule>(`SELECT id, name, priority, enabled, match, action, enable_monitoring, set FROM discovery_rules`);
    let accepted = 0, ignored = 0;
    await tx(async (c) => {
      const cands = await q(`SELECT c.*, s.type AS source_type FROM discovery_candidates c JOIN discovery_sources s ON s.id = c.source_id WHERE c.status = 'pending' ORDER BY (c.parent_identity_key IS NOT NULL)`, [], c);
      for (const cand of cands) {
        const d = decide(rules, cand.proposed, { sourceId: cand.source_id, sourceType: cand.source_type });
        if (d.action === 'auto_accept' && d.rule) {
          await acceptItem(c, cand.proposed, { sourceId: cand.source_id, enableMonitoring: d.rule.enable_monitoring, set: d.rule.set, actor: `Regel „${d.rule.name}“` });
          accepted++;
        } else if (d.action === 'ignore') {
          await q(`UPDATE discovery_candidates SET status = 'ignored', rule_id = $2, decided_at = now(), decided_by = $3 WHERE id = $1`, [cand.id, d.rule?.id ?? null, `Regel „${d.rule?.name}“`], c);
          ignored++;
        }
      }
      await syncAutoStructure(c);
    });
    await notify('discovery');
    return { accepted, ignored };
  });

  app.get('/api/discovery/adapters', async () => [
    { type: 'docker', label: 'Docker Engine', description: 'Container, Compose-Projekte und Services über den Docker-Socket oder eine entfernte Docker-API (tcp://host:2375).' },
    { type: 'host', label: 'Lokaler Linux-Host', description: 'Der Host, auf dem Hermes läuft, über read-only gemountete /proc, /sys und / (inkl. aktiver systemd-Dienste, falls /run gemountet ist).' },
    { type: 'network', label: 'Netzwerkbereich', description: 'TCP-Port-Scan über konfigurierte IPv4-Bereiche (max. 1024 Adressen je Bereich).' },
    { type: 'vmware', label: 'VMware ESXi / vCenter', description: 'Hypervisor-Hosts und VMs über die vSphere-API (nur lesender Benutzer genügt). VMs werden ihrem Host zugeordnet (läuft auf), inkl. Gast-IPs und Datastores.' },
    { type: 'podman', label: 'Podman', unavailable: 'Adapter-Schnittstelle vorhanden, Implementierung folgt (Podman-Socket ist Docker-API-kompatibel: als Docker-Quelle mit unix:///run/podman/podman.sock nutzbar).' },
    { type: 'snmp', label: 'SNMP-Netzwerkgeräte', unavailable: 'nicht in v1 – Geräte manuell im Inventar anlegen' },
    { type: 'windows', label: 'Windows-Hosts', unavailable: 'nicht in v1' },
  ]);
}
