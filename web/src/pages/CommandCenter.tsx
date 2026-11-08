import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { ago, dur, fmt, ts } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useLiveConnected } from '../lib/live';
import { CRIT_LABEL, DEP_TYPES, KIND_LABEL, STATUS_RANK } from '../lib/meta';
import { Badge, Empty, Field, Icon, Modal, StatusBadge, useToast } from '../components/ui';
import { Topology, KIND_CODE } from '../components/Topology';
import { EventFeed } from '../components/EventFeed';
import { IncidentDetail, MaintenanceDialog } from './Alerts';

const INFRA_KINDS = ['wan', 'router', 'firewall', 'switch', 'access_point', 'nas', 'hypervisor', 'vm', 'dns', 'dhcp', 'proxy', 'storage', 'external_api', 'service', 'database', 'network'];

export default function CommandCenter() {
  const nav = useNavigate();
  const { can } = useAuth();
  const live = useLiveConnected();
  const graph = useQuery({ queryKey: ['graph'], queryFn: () => get('/graph'), refetchInterval: 20000 });
  const ov = useQuery({ queryKey: ['overview'], queryFn: () => get('/overview'), refetchInterval: 15000 });
  const incidents = useQuery({ queryKey: ['incidents', 'open'], queryFn: () => get<any[]>('/incidents?status=open'), refetchInterval: 15000 });
  const [host, setHost] = useState('');
  const [group, setGroup] = useState('');
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [problems, setProblems] = useState(false);
  const [search, setSearch] = useState('');
  const [hideUnmonitored, setHideUnmonitored] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);
  const [incident, setIncident] = useState<string | null>(null);
  const [addInfra, setAddInfra] = useState(false);
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  const nodes: any[] = graph.data?.nodes ?? [];
  const edges: any[] = graph.data?.edges ?? [];
  const hosts = nodes.filter((n) => ['host', 'vm', 'hypervisor', 'nas'].includes(n.kind));
  const groups = [...new Set(nodes.map((n) => n.group_name).filter(Boolean))].sort();
  const kinds = [...new Set(nodes.map((n) => n.kind))].sort();

  const filter = useMemo(() => {
    let scope: Set<string> | null = null;
    if (host) {
      scope = new Set([host]);
      let grew = true;
      while (grew) { grew = false; for (const n of nodes) if (n.parent_id && scope.has(n.parent_id) && !scope.has(n.id)) { scope.add(n.id); grew = true; } }
      for (const e of edges) { if (scope.has(e.from_id) || scope.has(e.to_id)) { scope.add(e.from_id); scope.add(e.to_id); } }
    }
    let prob: Set<string> | null = null;
    if (problems) {
      prob = new Set(nodes.filter((n) => ['critical', 'warning', 'unknown'].includes(n.status) || n.impacted_by?.length || n.root_cause_ids?.length || n.in_maintenance).map((n) => n.id));
      for (const e of edges) if (prob.has(e.from_id) || prob.has(e.to_id)) { /* keep direct neighbours for context */ }
    }
    const s = search.toLowerCase();
    return (n: any) => (!scope || scope.has(n.id)) && (!group || n.group_name === group) && (!status || n.status === status) && (!kind || n.kind === kind)
      && (!prob || prob.has(n.id)) && (!s || n.label.toLowerCase().includes(s)) && (!hideUnmonitored || n.monitoring_enabled);
  }, [host, group, status, kind, problems, search, hideUnmonitored, nodes, edges]);

  const t = ov.data?.tiles ?? {};
  const worker = ov.data?.platform?.find((p: any) => p.component === 'worker');
  const workerOk = worker && worker.age_s < 60;
  const sel = selected ? nodes.find((n) => n.id === selected.id) ?? selected : null;

  return (
    <div className="cc">
      <div className="cc-head">
        <div className="row" style={{ gap: 14 }}>
          <h1>Command Center</h1>
          <span className="mono dim" style={{ fontSize: 12 }}>{now.toLocaleDateString('de-DE')} {now.toLocaleTimeString('de-DE')}</span>
          <span className="row mono" style={{ fontSize: 11.5, color: live ? 'var(--ok)' : 'var(--crit)' }}><span className={`dot ${live ? 'ok' : 'critical'}`} />{live ? 'LIVE' : 'OFFLINE'}</span>
          <span className="row mono" style={{ fontSize: 11.5, color: workerOk ? 'var(--text-2)' : 'var(--crit)' }} title="Heartbeat des Workers (Scheduler, Checks, Discovery)">
            <span className={`dot ${workerOk ? 'ok' : 'critical'}`} />Worker {worker ? `${Math.round(worker.age_s)}s` : 'fehlt'}</span>
        </div>
        <div className="cc-tiles">
          <Tile label="Kritisch" value={t.critical} cls={t.critical ? 'critical' : ''} onClick={() => { setStatus('critical'); setProblems(false); }} />
          <Tile label="Warnung" value={t.warning} cls={t.warning ? 'warning' : ''} onClick={() => { setStatus('warning'); setProblems(false); }} />
          <Tile label="Unbekannt" value={t.unknown} cls={t.unknown ? 'unknown' : ''} onClick={() => setStatus('unknown')} />
          <Tile label="OK" value={t.ok} cls="ok" onClick={() => setStatus('ok')} />
          <Tile label="Betroffen" value={t.impacted} cls={t.impacted ? 'impacted' : ''} onClick={() => { setProblems(true); setStatus(''); }} />
          <Tile label="Störungen" value={ov.data?.incidents?.open} cls={ov.data?.incidents?.critical ? 'critical' : ov.data?.incidents?.open ? 'warning' : ''} onClick={() => nav('/alerts')} />
          <Tile label="Hosts / Container" value={t.hosts !== undefined ? `${t.hosts}/${t.containers}` : undefined} onClick={() => nav('/inventory')} />
          <Tile label="Checks aktiv" value={ov.data?.checks ? `${ov.data.checks.active}` : undefined} sub={ov.data?.checks?.failing ? `${ov.data.checks.failing} fehlerhaft` : undefined} onClick={() => nav('/checks')} />
          <Tile label="Discovery" value={ov.data?.discovery?.pending} sub="neu in Inbox" cls={ov.data?.discovery?.pending ? 'info' : ''} onClick={() => nav('/discovery')} />
        </div>
      </div>
      <div className="cc-filters">
        <select value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host"><option value="">Alle Hosts</option>{hosts.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}</select>
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Gruppe"><option value="">Alle Gruppen</option>{groups.map((g) => <option key={g}>{g}</option>)}</select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Alle Zustände</option>{['critical', 'warning', 'unknown', 'ok', 'pending', 'unmonitored'].map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Typ"><option value="">Alle Typen</option>{kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}</select>
        <label className="check"><input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} />nur Störungen & Betroffene</label>
        <label className="check"><input type="checkbox" checked={hideUnmonitored} onChange={(e) => setHideUnmonitored(e.target.checked)} />nur überwachte</label>
        {(host || group || status || kind || problems || search || hideUnmonitored) && <button className="ghost sm" onClick={() => { setHost(''); setGroup(''); setStatus(''); setKind(''); setProblems(false); setSearch(''); setHideUnmonitored(false); }}>zurücksetzen</button>}
        <div className="spacer" />
        <div className="search"><Icon name="search" /><input placeholder="Knoten suchen" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} /></div>
        {can('operator') && <button onClick={() => setAddInfra(true)}><Icon name="plus" />Infrastruktur</button>}
      </div>
      <div className="cc-body">
        <div className="cc-map">
          {graph.isLoading ? <Empty>Lade Topologie…</Empty> : nodes.length === 0 ? <Empty>Noch keine Ressourcen. Die Discovery füllt die Karte, sobald sie den ersten Lauf beendet hat.</Empty>
            : <Topology data={graph.data} filter={filter} selectedId={sel?.id} onSelect={setSelected} />}
          <Legend />
        </div>
        <aside className="cc-rail">
          {sel ? <NodeCard n={sel} nodes={nodes} edges={edges} onClose={() => setSelected(null)} onIncident={setIncident} /> : null}
          <section>
            <h3>Aktive Störungen <span className="dim">({incidents.data?.length ?? 0})</span></h3>
            {!incidents.data?.length ? <div className="cc-allgood"><span className="dot ok" />Keine offenen Störungen</div> : incidents.data.slice(0, 6).map((i) => (
              <button key={i.id} className="cc-inc" onClick={() => setIncident(i.id)}>
                <span className={`dot ${i.severity}`} />
                <span style={{ minWidth: 0 }}><span className="cc-inc-title">{i.resource_name}</span><span className="cc-inc-sub">{i.title.replace(`${i.resource_name}: `, '')}</span>
                  <span className="cc-inc-meta">seit {dur((Date.now() - new Date(i.opened_at).getTime()) / 1000)}{i.affected_ids.length ? ` · ${i.affected_ids.length} betroffen` : ''}{i.flapping ? ' · flattert' : ''}{i.in_maintenance ? ' · Wartung' : ''}</span></span>
              </button>))}
          </section>
          <TopConsumers onSelect={(id) => setSelected(nodes.find((n) => n.id === id) ?? null)} />
          <StateHistory />
          <section style={{ flex: 1, minHeight: 160 }}>
            <h3>Letzte Ereignisse</h3>
            <EventFeed limit={25} compact />
          </section>
        </aside>
      </div>
      {incident && <IncidentDetail id={incident} onClose={() => setIncident(null)} />}
      {addInfra && <InfraDialog nodes={nodes} onClose={() => setAddInfra(false)} />}
    </div>
  );
}

function Tile({ label, value, cls, sub, onClick }: { label: string; value: any; cls?: string; sub?: string; onClick?: () => void }) {
  return (
    <button className={`cc-tile ${cls ?? ''}`} onClick={onClick}>
      <span className="l">{label}</span><span className="v">{value ?? '–'}</span>{sub && <span className="s">{sub}</span>}
    </button>
  );
}

function Legend() {
  return (
    <div className="cc-legend">
      {[['ok', 'OK'], ['warning', 'Warning'], ['critical', 'Critical'], ['unknown', 'Unknown'], ['unmonitored', 'nicht überwacht']].map(([s, l]) => <span key={s}><span className={`dot ${s}`} />{l}</span>)}
      <span><span className="lg-box" style={{ borderColor: '#f43f5e' }} />Ursache</span>
      <span><span className="lg-box" style={{ borderColor: '#fb923c', borderStyle: 'dashed' }} />betroffen</span>
      <span><span className="lg-line" />hart</span><span><span className="lg-line soft" />weich</span>
    </div>
  );
}

function NodeCard({ n, nodes, edges, onClose, onIncident }: { n: any; nodes: any[]; edges: any[]; onClose: () => void; onIncident: (id: string) => void }) {
  const { can } = useAuth();
  const [maint, setMaint] = useState(false);
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const up = edges.filter((e) => e.from_id === n.id).map((e) => ({ e, r: byId.get(e.to_id) })).filter((x) => x.r);
  const down = edges.filter((e) => e.to_id === n.id).map((e) => ({ e, r: byId.get(e.from_id) })).filter((x) => x.r);
  const vit = n.vitals ?? {};
  return (
    <section className="cc-node">
      <div className="row"><span className="cc-code">{KIND_CODE[n.kind]}</span><b style={{ fontSize: 14, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</b>
        <button className="ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Schließen"><Icon name="x" /></button></div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
        <StatusBadge status={n.status} />{n.root_cause_ids?.length > 0 && <Badge kind="impacted">Folgefehler</Badge>}{n.impacted_by?.length > 0 && !n.root_cause_ids?.length && <Badge kind="impacted">betroffen</Badge>}
        {n.in_maintenance && <Badge kind="maint">Wartung</Badge>}<Badge>{KIND_LABEL[n.kind]}</Badge><Badge>{CRIT_LABEL[n.criticality]}</Badge>
      </div>
      {n.status_message && <div className="cc-msg">{n.status_message}</div>}
      <dl className="kv" style={{ gridTemplateColumns: '110px 1fr', fontSize: 12.5 }}>
        <dt>Zustand seit</dt><dd>{ago(n.status_since)}</dd>
        <dt>Letzte Änderung</dt><dd title={ts(n.last_change_at)}>{ago(n.last_change_at)}</dd>
        {n.address && <><dt>Adresse</dt><dd className="mono">{n.address}</dd></>}
        {n.compose_project && <><dt>Compose</dt><dd className="mono">{n.compose_project}</dd></>}
        {vit.cpu_percent != null && <><dt>CPU</dt><dd className="mono">{fmt(vit.cpu_percent, 'percent')}</dd></>}
        {vit.mem_used_percent != null && <><dt>RAM</dt><dd className="mono">{fmt(vit.mem_used_percent, 'percent')}</dd></>}
        {vit.mem_used_bytes != null && vit.mem_used_percent == null && <><dt>RAM</dt><dd className="mono">{fmt(vit.mem_used_bytes, 'bytes')}{vit.mem_limit_percent != null ? ` (${fmt(vit.mem_limit_percent, 'percent')} vom Limit)` : ''}</dd></>}
        {vit.response_ms != null && <><dt>Antwortzeit</dt><dd className="mono">{fmt(vit.response_ms, 'ms')}</dd></>}
        {vit.query_ms != null && <><dt>DB-Abfrage</dt><dd className="mono">{fmt(vit.query_ms, 'ms')}</dd></>}
      </dl>
      {up.length > 0 && <><h3 style={{ marginTop: 10 }}>Hängt ab von</h3>{up.map(({ e, r }) => <div key={e.id} className="cc-rel"><span className={`dot ${r.status}`} />{r.label}<span className="dim">{DEP_TYPES[e.type]}{e.attributes?.vlan ? ` · VLAN ${e.attributes.vlan}` : ''}</span></div>)}</>}
      {down.length > 0 && <><h3 style={{ marginTop: 10 }}>Wird benötigt von</h3>{down.slice(0, 8).map(({ e, r }) => <div key={e.id} className="cc-rel"><span className={`dot ${r.status}`} />{r.label}<span className="dim">{DEP_TYPES[e.type]}</span></div>)}{down.length > 8 && <div className="dim" style={{ fontSize: 12 }}>+ {down.length - 8} weitere</div>}</>}
      <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <Link className="btn" to={`/resources/${n.id}`}>Details öffnen</Link>
        {n.incident_id && <button onClick={() => onIncident(n.incident_id)}>Störung</button>}
        {can('operator') && <button className="ghost" onClick={() => setMaint(true)}>Wartung</button>}
      </div>
      {maint && <MaintenanceDialog preset={[n.id]} onClose={() => setMaint(false)} />}
    </section>
  );
}

function TopConsumers({ onSelect }: { onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<'cpu' | 'memory' | 'net'>('cpu');
  const top = useQuery({ queryKey: ['metrics', 'top'], queryFn: () => get('/top'), refetchInterval: 30000 });
  const d = top.data;
  const rows: any[] = !d ? [] : tab === 'cpu' ? [...d.hosts_cpu, ...d.cpu] : tab === 'memory' ? d.memory : [...d.net_rx.map((r: any) => ({ ...r, dir: '↓' })), ...d.net_tx.map((r: any) => ({ ...r, dir: '↑' }))].sort((a, b) => b.last_value - a.last_value).slice(0, 8);
  const max = Math.max(1, ...rows.map((r) => r.last_value));
  return (
    <section>
      <div className="row"><h3 style={{ margin: 0 }}>Top-Verbraucher</h3>
        <div className="tabs" style={{ marginLeft: 'auto' }}>{([['cpu', 'CPU'], ['memory', 'RAM'], ['net', 'Netz']] as const).map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setTab(k)}>{l}</button>)}</div></div>
      <div style={{ marginTop: 8 }}>
        {rows.length === 0 ? <div className="dim" style={{ fontSize: 12.5 }}>Noch keine Messwerte (Container- bzw. Host-Checks liefern sie).</div> : rows.map((r, i) => (
          <button key={r.resource_id + r.metric + i} className="cc-top" onClick={() => onSelect(r.resource_id)}>
            <span className="name">{r.kind === 'host' ? <b>{r.name}</b> : r.name}{r.dir ? ` ${r.dir}` : ''}</span>
            <span className="bar"><span style={{ width: `${(r.last_value / (tab === 'cpu' ? Math.max(100, max) : max)) * 100}%`, background: tab === 'cpu' && r.last_value > 85 ? 'var(--warn)' : undefined }} /></span>
            <span className="val">{fmt(r.last_value, r.unit)}</span>
          </button>))}
      </div>
    </section>
  );
}

function StateHistory() {
  const h = useQuery({ queryKey: ['overview', 'history'], queryFn: () => get<any[]>('/overview/history?hours=24'), refetchInterval: 60000 });
  const data = h.data ?? [];
  const max = Math.max(1, ...data.map((b) => b.total));
  const end = Date.now() / 1000;
  const start = end - 86400;
  const slot = 86400 / 96;
  return (
    <section>
      <h3>Zustandsverlauf 24 h <span className="dim">(Check-Ergebnisse je 15 min)</span></h3>
      {data.length === 0 ? <div className="dim" style={{ fontSize: 12.5 }}>Noch keine Ergebnisse.</div> : (
        <>
          <svg width="100%" height="56" viewBox="0 0 384 56" preserveAspectRatio="none" role="img" aria-label="Zustandsverlauf">
            <rect x={0} y={55} width={384} height={1} fill="#16202a" />
            {data.map((b) => {
              const x = Math.floor((b.t - start) / slot) * 4;
              if (x < 0) return null;
              const okH = ((b.total - b.warning - b.critical - b.unknown) / max) * 52;
              const wH = (b.warning / max) * 52, cH = (b.critical / max) * 52, uH = (b.unknown / max) * 52;
              let y = 56;
              return (
                <g key={b.t}><title>{`${new Date(b.t * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}: ${b.total} Ergebnisse, ${b.critical} critical, ${b.warning} warning, ${b.unknown} unknown`}</title>
                  <rect x={x} y={(y -= okH)} width={3} height={okH} fill="#1f4d3d" />
                  <rect x={x} y={(y -= uH)} width={3} height={uH} fill="#64748b" />
                  <rect x={x} y={(y -= wH)} width={3} height={wH} fill="#fbbf24" />
                  <rect x={x} y={(y -= cH)} width={3} height={cH} fill="#f43f5e" />
                </g>);
            })}
          </svg>
          <div className="row mono dim" style={{ fontSize: 10.5, justifyContent: 'space-between' }}><span>-24 h</span><span>-12 h</span><span>jetzt</span></div>
        </>
      )}
    </section>
  );
}

function InfraDialog({ nodes, onClose }: { nodes: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<any>({ kind: 'router', name: '', host: '', url: '', group_name: 'Netzwerk', criticality: 'high', link_to: '', link_type: 'network_link', vlan: '', subnet: '', direction: 'provider', checks: true });
  const save = useMutation({
    mutationFn: async () => {
      const r = await post('/resources', { name: d.name, kind: d.kind, group_name: d.group_name || null, criticality: d.criticality, connection: { host: d.host || undefined, url: d.url || undefined }, monitoring_enabled: true, default_checks: d.checks, tags: [] });
      if (d.link_to) {
        // provider: the new node serves the selected one (e.g. switch → host); else it depends on it
        const attrs = Object.fromEntries(Object.entries({ vlan: d.vlan, subnet: d.subnet }).filter(([, v]) => v));
        await post('/dependencies', d.direction === 'provider' ? { from_id: d.link_to, to_id: r.id, type: d.link_type, strength: 'hard', attributes: attrs } : { from_id: r.id, to_id: d.link_to, type: d.link_type, strength: 'hard', attributes: attrs });
      }
      return r;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['graph'] }); qc.invalidateQueries({ queryKey: ['resources'] }); toast('Knoten angelegt'); onClose(); },
    onError: (e: Error) => toast(e.message, true),
  });
  return (
    <Modal title="Infrastruktur-Knoten hinzufügen" wide onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!d.name || save.isPending} onClick={() => save.mutate()}>Anlegen</button></>}>
      <div className="sub">Netzwerkgeräte und andere Komponenten ohne Discovery-Adapter (Router, Firewall, Switch, WAN, NAS …) legst du hier an. Mit Adresse/URL bekommen sie echte Erreichbarkeits-Checks.</div>
      <div className="form-grid">
        <Field label="Typ"><select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value })}>{INFRA_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="Name"><input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="opnsense" /></Field>
        <Field label="Adresse (IP/Host)" hint="Ping-Check"><input value={d.host} onChange={(e) => setD({ ...d, host: e.target.value })} placeholder="192.168.1.1" /></Field>
        <Field label="URL (optional)" hint="HTTP- und TLS-Check"><input value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://192.168.1.1" /></Field>
        <Field label="Gruppe"><input value={d.group_name} onChange={(e) => setD({ ...d, group_name: e.target.value })} /></Field>
        <Field label="Kritikalität"><select value={d.criticality} onChange={(e) => setD({ ...d, criticality: e.target.value })}>{Object.entries(CRIT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <h3 className="span2" style={{ margin: '4px 0 0' }}>Verbindung in der Topologie (optional)</h3>
        <Field label="Verbunden mit"><select value={d.link_to} onChange={(e) => setD({ ...d, link_to: e.target.value })}><option value="">–</option>{[...nodes].sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) || a.label.localeCompare(b.label)).map((n) => <option key={n.id} value={n.id}>{n.label} ({KIND_LABEL[n.kind]})</option>)}</select></Field>
        <Field label="Richtung"><select value={d.direction} onChange={(e) => setD({ ...d, direction: e.target.value })}><option value="provider">neuer Knoten versorgt diesen (z. B. Switch → Host)</option><option value="dependent">neuer Knoten hängt von diesem ab (z. B. Router → WAN)</option></select></Field>
        <Field label="Art"><select value={d.link_type} onChange={(e) => setD({ ...d, link_type: e.target.value })}>{Object.entries(DEP_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <div className="row"><Field label="VLAN"><input value={d.vlan} onChange={(e) => setD({ ...d, vlan: e.target.value })} style={{ width: 80 }} /></Field><Field label="Subnetz"><input value={d.subnet} onChange={(e) => setD({ ...d, subnet: e.target.value })} placeholder="10.0.0.0/24" /></Field></div>
        <label className="check span2"><input type="checkbox" checked={d.checks} onChange={(e) => setD({ ...d, checks: e.target.checked })} />Erreichbarkeits-Checks aus Adresse/URL anlegen</label>
      </div>
    </Modal>
  );
}
