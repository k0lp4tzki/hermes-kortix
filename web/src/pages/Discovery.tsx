import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put } from '../lib/api';
import { ago, dur } from '../lib/format';
import { useAuth } from '../lib/auth';
import { CRIT_LABEL, CRITS, KIND_LABEL, KINDS } from '../lib/meta';
import { Badge, Empty, Field, Icon, Modal, useToast } from '../components/ui';

export default function Discovery() {
  const [tab, setTab] = useState('pending');
  const cands = useQuery({ queryKey: ['discovery', 'candidates'], queryFn: () => get<any[]>('/discovery/candidates'), refetchInterval: 20000 });
  const n = (s: string) => (cands.data ?? []).filter((c) => c.status === s).length;
  const tabs: [string, string, number | null][] = [['pending', 'Inbox', n('pending')], ['ignored', 'Ignoriert', n('ignored')], ['accepted', 'Übernommen', n('accepted')], ['rules', 'Regeln', null], ['sources', 'Quellen', null]];
  return (
    <div className="page">
      <div className="page-head"><h1>Discovery</h1><span className="sub">Entdeckt heißt nicht überwacht: Funde warten hier auf Freigabe, außer eine Regel übernimmt sie.</span></div>
      <div className="toolbar"><div className="tabs">{tabs.map(([k, l, c]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}{c !== null && <span className="n">{c}</span>}</button>)}</div></div>
      {['pending', 'ignored', 'accepted'].includes(tab) && <Candidates status={tab} all={cands.data ?? []} loading={cands.isLoading} />}
      {tab === 'rules' && <Rules />}
      {tab === 'sources' && <Sources />}
    </div>
  );
}

function summary(c: any): string {
  const a = c.proposed?.attributes ?? {};
  const parts: string[] = [];
  if (a.image) parts.push(a.image);
  if (a.state) parts.push(a.state + (a.health ? `/${a.health}` : ''));
  if (a.ports?.length) parts.push('Ports ' + a.ports.map((p: any) => (p.public ? `${p.public}→${p.private}` : p.private)).join(','));
  if (a.open_ports?.length) parts.push('offen ' + a.open_ports.join(','));
  if (a.ips?.length) parts.push(a.ips.join(','));
  if (a.os) parts.push(a.os);
  if (a.unit) parts.push(a.unit);
  return parts.join(' · ');
}

function Candidates({ status, all, loading }: { status: string; all: any[]; loading: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [monitor, setMonitor] = useState(true);
  const [rule, setRule] = useState(false);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setSel(new Set()), [status]);
  const list = all.filter((c) => c.status === status && (!search || `${c.name} ${summary(c)} ${c.parent_name ?? ''}`.toLowerCase().includes(search.toLowerCase())));
  const act = useMutation({
    mutationFn: ({ action, ids }: { action: string; ids: string[] }) => post(`/discovery/candidates/${action}`, { ids, enable_monitoring: monitor, create_rule: rule }),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ['discovery'] }); qc.invalidateQueries({ queryKey: ['resources'] }); setSel(new Set()); toast(v.action === 'approve' ? 'Ins Inventar übernommen' : v.action === 'ignore' ? 'Ignoriert' : 'Zurück in die Inbox'); },
    onError: (e: Error) => toast(e.message, true),
  });
  const ids = [...sel];
  return (
    <>
      <div className="toolbar">
        {status === 'pending' && can('operator') && <>
          <button className="primary" disabled={!sel.size || act.isPending} onClick={() => act.mutate({ action: 'approve', ids })}><Icon name="check" />Übernehmen ({sel.size})</button>
          <label className="check"><input type="checkbox" checked={monitor} onChange={(e) => setMonitor(e.target.checked)} />mit Überwachung</label>
          <button disabled={!sel.size} onClick={() => act.mutate({ action: 'ignore', ids })}>Ignorieren</button>
          <label className="check" title="Legt pro Eintrag eine Ignorier-Regel an, damit er auch nach Neuerkennung ignoriert bleibt"><input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} />dauerhaft (Regel)</label>
        </>}
        {status === 'ignored' && can('operator') && <button disabled={!sel.size} onClick={() => act.mutate({ action: 'reset', ids })}>Zurück in die Inbox</button>}
        <div className="spacer" />
        <div className="search"><Icon name="search" /><input placeholder="Funde durchsuchen" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>
      <div className="panel flush table-wrap">
        {loading ? <Empty>Lade…</Empty> : list.length === 0 ? <Empty>{status === 'pending' ? 'Die Inbox ist leer. Neue Funde der Discovery-Quellen erscheinen hier.' : 'Keine Einträge.'}</Empty> : (
          <table className="t">
            <thead><tr>
              {status !== 'accepted' && <th style={{ width: 28 }}><input type="checkbox" aria-label="Alle" checked={list.every((c) => sel.has(c.id))} onChange={(e) => setSel(e.target.checked ? new Set(list.map((c) => c.id)) : new Set())} /></th>}
              <th>Typ</th><th>Name</th><th>Host</th><th>Details</th><th>Quelle</th><th>Zuerst gesehen</th><th>Zuletzt gesehen</th><th>Entscheidung</th>
            </tr></thead>
            <tbody>{list.map((c) => [
              <tr key={c.id} className="click" onClick={() => setOpen(open === c.id ? null : c.id)}>
                {status !== 'accepted' && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={c.name} checked={sel.has(c.id)} onChange={() => { const s = new Set(sel); s.has(c.id) ? s.delete(c.id) : s.add(c.id); setSel(s); }} /></td>}
                <td>{KIND_LABEL[c.kind] ?? c.kind}</td>
                <td style={{ fontWeight: 500 }}>{c.name}</td>
                <td className="dim">{c.parent_name ?? (c.parent_identity_key ? <span title={c.parent_identity_key}>noch nicht übernommen</span> : '–')}</td>
                <td className="mono dim" style={{ fontSize: 11.5, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary(c)}</td>
                <td className="dim">{c.source_name}</td>
                <td className="dim">{ago(c.first_seen_at)}</td>
                <td className="dim">{ago(c.last_seen_at)}</td>
                <td className="dim">{c.decided_by ?? (c.rule_name ? `Regel „${c.rule_name}“` : '–')}</td>
              </tr>,
              open === c.id ? <tr key={c.id + '-d'}><td colSpan={9} style={{ background: 'var(--bg-2)' }}>
                <div className="mono dim" style={{ fontSize: 11 }}>Identität: {c.identity_key}</div>
                <pre className="mono" style={{ fontSize: 11, maxHeight: 260, overflow: 'auto', margin: '6px 0 0' }}>{JSON.stringify(c.proposed?.attributes, null, 2)}</pre>
              </td></tr> : null,
            ])}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

const ACTION_LABEL: Record<string, string> = { auto_accept: 'automatisch übernehmen', ignore: 'ignorieren', manual: 'manuelle Freigabe' };

function Rules() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const rules = useQuery({ queryKey: ['discovery', 'rules'], queryFn: () => get<any[]>('/discovery/rules') });
  const [edit, setEdit] = useState<any | null>(null);
  const apply = useMutation({ mutationFn: () => post('/discovery/rules/apply'), onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['discovery'] }); toast(`${r.accepted} übernommen, ${r.ignored} ignoriert`); }, onError: (e: Error) => toast(e.message, true) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/discovery/rules/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['discovery', 'rules'] }) });
  const describe = (m: any) => {
    const p: string[] = [];
    if (m.kinds?.length) p.push(`Typ ∈ ${m.kinds.map((k: string) => KIND_LABEL[k] ?? k).join(', ')}`);
    if (m.name_glob) p.push(`Name ~ ${m.name_glob}`);
    if (m.image_glob) p.push(`Image ~ ${m.image_glob}`);
    if (m.compose_project) p.push(`Compose ~ ${m.compose_project}`);
    if (m.labels) p.push(...Object.entries(m.labels).map(([k, v]) => `Label ${k}=${v}`));
    if (m.cidrs?.length) p.push(`Netz ${m.cidrs.join(', ')}`);
    if (m.ports?.length) p.push(`Port ${m.ports.join(', ')}`);
    if (m.source_types?.length) p.push(`Quelle ${m.source_types.join(', ')}`);
    if (m.source_ids?.length) p.push(`${m.source_ids.length} bestimmte Quelle(n)`);
    return p.join(' und ') || 'alles';
  };
  return (
    <>
      <div className="toolbar">
        <span className="sub">Die erste passende Regel (kleinste Priorität) entscheidet. Ohne Treffer: manuelle Freigabe in der Inbox.</span>
        <div className="spacer" />
        {can('operator') && <><button onClick={() => apply.mutate()}>Regeln auf Inbox anwenden</button>
          <button className="primary" onClick={() => setEdit({ name: '', priority: 100, enabled: true, match: {}, action: 'auto_accept', enable_monitoring: true, set: {} })}><Icon name="plus" />Regel anlegen</button></>}
      </div>
      <div className="panel flush">
        <table className="t">
          <thead><tr><th>Prio</th><th>Name</th><th>Bedingung</th><th>Aktion</th><th>Überwachung</th><th>Setzt</th><th /></tr></thead>
          <tbody>{(rules.data ?? []).map((r) => (
            <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.5 }}>
              <td className="num">{r.priority}</td><td>{r.name}{r.system && <span className="dim"> · Standard</span>}</td><td className="dim">{describe(r.match)}</td>
              <td><Badge kind={r.action === 'ignore' ? 'critical' : r.action === 'auto_accept' ? 'ok' : 'info'}>{ACTION_LABEL[r.action]}</Badge></td>
              <td>{r.action === 'auto_accept' ? (r.enable_monitoring ? 'aktivieren' : 'aus') : '–'}</td>
              <td className="dim">{Object.entries(r.set ?? {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' ') || '–'}</td>
              <td style={{ textAlign: 'right' }}>{can('operator') && <><button className="sm" onClick={() => setEdit(r)}>Bearbeiten</button> <button className="sm danger" onClick={() => confirm('Regel löschen?') && remove.mutate(r.id)}>Löschen</button></>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      {edit && <RuleEditor rule={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function RuleEditor({ rule, onClose }: { rule: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [r, setR] = useState<any>(rule);
  const [text, setText] = useState<Record<string, string>>({
    kinds: (rule.match.kinds ?? []).join(','), labels: Object.entries(rule.match.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(','),
    cidrs: (rule.match.cidrs ?? []).join(','), ports: (rule.match.ports ?? []).join(','), tags: (rule.set.tags ?? []).join(','),
  });
  const body = useMemo(() => {
    const m: any = {};
    if (text.kinds.trim()) m.kinds = text.kinds.split(',').map((s) => s.trim()).filter(Boolean);
    for (const k of ['name_glob', 'image_glob', 'compose_project']) if (r.match[k]) m[k] = r.match[k];
    if (text.labels.trim()) m.labels = Object.fromEntries(text.labels.split(',').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p[0]).map(([k, v]) => [k, v ?? '*']));
    if (text.cidrs.trim()) m.cidrs = text.cidrs.split(',').map((s) => s.trim()).filter(Boolean);
    if (text.ports.trim()) m.ports = text.ports.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    if (r.match.source_ids?.length) m.source_ids = r.match.source_ids;
    if (r.match.source_types?.length) m.source_types = r.match.source_types;
    const set: any = { ...r.set };
    set.tags = text.tags.split(',').map((s) => s.trim()).filter(Boolean);
    if (!set.tags.length) delete set.tags;
    for (const k of Object.keys(set)) if (set[k] === '' || set[k] === undefined) delete set[k];
    return { name: r.name, priority: Number(r.priority), enabled: r.enabled, match: m, action: r.action, enable_monitoring: r.enable_monitoring, set };
  }, [r, text]);
  const preview = useQuery({ queryKey: ['discovery', 'preview', JSON.stringify(body)], queryFn: () => post<any[]>('/discovery/rules/preview', { ...body, name: body.name || 'x' }) });
  const save = useMutation({
    mutationFn: () => (r.id ? put(`/discovery/rules/${r.id}`, body) : post('/discovery/rules', body)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['discovery'] }); onClose(); toast('Regel gespeichert'); },
    onError: (e: Error) => toast(e.message, true),
  });
  const m = (k: string, v: string) => setR({ ...r, match: { ...r.match, [k]: v || undefined } });
  return (
    <Modal title={r.id ? 'Regel bearbeiten' : 'Regel anlegen'} wide onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!r.name || save.isPending} onClick={() => save.mutate()}>Speichern</button></>}>
      <div className="form-grid">
        <Field label="Name"><input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
        <Field label="Priorität" hint="kleiner = zuerst geprüft"><input type="number" value={r.priority} onChange={(e) => setR({ ...r, priority: e.target.value })} /></Field>
        <Field label="Aktion"><select value={r.action} onChange={(e) => setR({ ...r, action: e.target.value })}>{Object.entries(ACTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Status"><label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} />Regel aktiv</label></Field>
        <h3 className="span2" style={{ margin: '6px 0 0' }}>Bedingungen (alle müssen zutreffen)</h3>
        <Field label="Typen" hint={`kommagetrennt: ${KINDS.slice(0, 8).join(', ')} …`}><input value={text.kinds} onChange={(e) => setText({ ...text, kinds: e.target.value })} placeholder="container" /></Field>
        <Field label="Name (Muster)" hint="* und ? als Platzhalter"><input value={r.match.name_glob ?? ''} onChange={(e) => m('name_glob', e.target.value)} /></Field>
        <Field label="Image (Muster)"><input value={r.match.image_glob ?? ''} onChange={(e) => m('image_glob', e.target.value)} placeholder="linuxserver/*" /></Field>
        <Field label="Compose-Projekt (Muster)"><input value={r.match.compose_project ?? ''} onChange={(e) => m('compose_project', e.target.value)} /></Field>
        <Field label="Labels" hint="key=wert, key=* für vorhanden"><input value={text.labels} onChange={(e) => setText({ ...text, labels: e.target.value })} placeholder="hermes.monitor=true" /></Field>
        <Field label="Netzbereiche (CIDR)"><input value={text.cidrs} onChange={(e) => setText({ ...text, cidrs: e.target.value })} placeholder="192.168.1.0/24" /></Field>
        <Field label="Offene Ports"><input value={text.ports} onChange={(e) => setText({ ...text, ports: e.target.value })} placeholder="22, 443" /></Field>
        {r.action === 'auto_accept' && <>
          <h3 className="span2" style={{ margin: '6px 0 0' }}>Beim Übernehmen</h3>
          <label className="check span2"><input type="checkbox" checked={r.enable_monitoring} onChange={(e) => setR({ ...r, enable_monitoring: e.target.checked })} />Überwachung sofort aktivieren</label>
          <Field label="Umgebung"><input value={r.set.environment ?? ''} onChange={(e) => setR({ ...r, set: { ...r.set, environment: e.target.value } })} /></Field>
          <Field label="Gruppe"><input value={r.set.group_name ?? ''} onChange={(e) => setR({ ...r, set: { ...r.set, group_name: e.target.value } })} /></Field>
          <Field label="Kritikalität"><select value={r.set.criticality ?? ''} onChange={(e) => setR({ ...r, set: { ...r.set, criticality: e.target.value || undefined } })}><option value="">Standard</option>{CRITS.map((c) => <option key={c} value={c}>{CRIT_LABEL[c]}</option>)}</select></Field>
          <Field label="Tags"><input value={text.tags} onChange={(e) => setText({ ...text, tags: e.target.value })} /></Field>
        </>}
      </div>
      <div className="callout">
        <b>Vorschau:</b> {preview.data ? `${preview.data.length} Fund(e) in Inbox/Ignoriert würden passen` : '…'}
        {preview.data && preview.data.length > 0 && <div className="mono" style={{ fontSize: 11.5, marginTop: 6, maxHeight: 120, overflow: 'auto' }}>{preview.data.slice(0, 50).map((c) => `${KIND_LABEL[c.kind] ?? c.kind}: ${c.name} (${c.status})`).join('\n').split('\n').map((l, i) => <div key={i}>{l}</div>)}</div>}
      </div>
    </Modal>
  );
}

function Sources() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const sources = useQuery({ queryKey: ['discovery', 'sources'], queryFn: () => get<any[]>('/discovery/sources'), refetchInterval: 5000 });
  const adapters = useQuery({ queryKey: ['discovery', 'adapters'], queryFn: () => get<any[]>('/discovery/adapters') });
  const [edit, setEdit] = useState<any | null>(null);
  const run = useMutation({ mutationFn: (id: string) => post(`/discovery/sources/${id}/run`), onSuccess: (r: any) => toast(r.message) });
  const toggle = useMutation({ mutationFn: (s: any) => patch(`/discovery/sources/${s.id}`, { enabled: !s.enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ['discovery', 'sources'] }) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/discovery/sources/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['discovery', 'sources'] }), onError: (e: Error) => toast(e.message, true) });
  return (
    <>
      <div className="toolbar"><div className="spacer" />{can('operator') && <button className="primary" onClick={() => setEdit({ name: '', type: 'docker', config: { endpoint: 'tcp://192.168.1.10:2375', include_stopped: true }, interval_s: 120, orphan_after_s: 86400, enabled: true })}><Icon name="plus" />Quelle anlegen</button>}</div>
      <div className="panel flush">
        <table className="t">
          <thead><tr><th>Quelle</th><th>Typ</th><th>Konfiguration</th><th>Intervall</th><th>Letzter Lauf</th><th>Funde</th><th>Ergebnis</th><th /></tr></thead>
          <tbody>{(sources.data ?? []).map((s) => (
            <tr key={s.id} style={{ opacity: s.enabled ? 1 : 0.55 }}>
              <td style={{ fontWeight: 500 }}>{s.name}</td><td>{s.type}</td>
              <td className="mono dim" style={{ fontSize: 11.5 }}>{s.type === 'docker' ? s.config.endpoint : s.type === 'network' ? (s.config.cidrs?.join(', ') || 'keine Bereiche') : s.config.systemd === false ? 'ohne systemd' : '/proc, /sys, systemd'}</td>
              <td className="num">{dur(s.interval_s)}</td>
              <td className="dim">{s.last_run_at ? `${ago(s.last_run_at)} (${s.last_duration_ms} ms)` : 'noch nie'}</td>
              <td className="num">{s.last_item_count ?? '–'} <span className="dim">/ {s.resource_count} übern. / {s.pending_count} offen</span></td>
              <td>{!s.enabled ? <Badge>deaktiviert</Badge> : s.last_error ? <span className="err" style={{ fontSize: 12 }}>{s.last_error}</span> : s.last_run_at ? <Badge kind="ok">ok</Badge> : <Badge>wartet</Badge>}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{can('operator') && <>
                <button className="sm" onClick={() => run.mutate(s.id)} disabled={!s.enabled}><Icon name="play" size={12} />Jetzt</button>{' '}
                <button className="sm" onClick={() => toggle.mutate(s)}>{s.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>{' '}
                <button className="sm" onClick={() => setEdit(s)}>Bearbeiten</button>{' '}
                {!s.system && <button className="sm danger" onClick={() => confirm('Quelle löschen?') && remove.mutate(s.id)}>Löschen</button>}</>}
              </td>
            </tr>))}</tbody>
        </table>
      </div>
      <h3 style={{ marginTop: 18 }}>Verfügbare Adapter</h3>
      <div className="grid3">{(adapters.data ?? []).map((a) => (
        <div key={a.type} className="panel" style={{ opacity: a.unavailable ? 0.65 : 1 }}>
          <div className="row"><b>{a.label}</b>{a.unavailable ? <Badge>nicht verfügbar</Badge> : <Badge kind="ok">verfügbar</Badge>}</div>
          <div className="sub" style={{ marginTop: 4 }}>{a.description ?? a.unavailable}</div>
        </div>))}</div>
      {edit && <SourceEditor source={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function SourceEditor({ source, onClose }: { source: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [s, setS] = useState<any>(source);
  const [list, setList] = useState({ cidrs: (source.config.cidrs ?? []).join(', '), exclude: (source.config.exclude ?? []).join(', '), ports: (source.config.ports ?? []).join(', ') });
  const c = (k: string, v: any) => setS({ ...s, config: { ...s.config, [k]: v } });
  const save = useMutation({
    mutationFn: () => {
      const config = { ...s.config };
      if (s.type === 'network') {
        const split = (x: string) => x.split(',').map((y) => y.trim()).filter(Boolean);
        config.cidrs = split(list.cidrs); config.exclude = split(list.exclude); config.ports = split(list.ports).map(Number);
      }
      const body = { name: s.name, type: s.type, config, enabled: s.enabled, interval_s: Number(s.interval_s), orphan_after_s: Number(s.orphan_after_s) };
      return s.id ? patch(`/discovery/sources/${s.id}`, body) : post('/discovery/sources', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['discovery', 'sources'] }); onClose(); toast('Quelle gespeichert'); },
    onError: (e: Error) => toast(e.message, true),
  });
  return (
    <Modal title={s.id ? `Quelle ${s.name}` : 'Quelle anlegen'} onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!s.name} onClick={() => save.mutate()}>Speichern</button></>}>
      <div className="form-grid">
        <Field label="Name"><input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field>
        <Field label="Typ"><select value={s.type} disabled={!!s.id} onChange={(e) => setS({ ...s, type: e.target.value, config: e.target.value === 'network' ? { cidrs: [], ports: [], exclude: [], timeout_ms: 400 } : e.target.value === 'docker' ? { endpoint: 'tcp://', include_stopped: true } : { systemd: true } })}>
          <option value="docker">Docker Engine</option><option value="network">Netzwerkbereich</option><option value="host">Lokaler Host</option></select></Field>
        <Field label="Intervall (Sekunden)"><input type="number" min={10} value={s.interval_s} onChange={(e) => setS({ ...s, interval_s: e.target.value })} /></Field>
        <Field label="Verwaist nach (Sekunden)" hint="So lange fehlend, dann als verwaist markiert"><input type="number" value={s.orphan_after_s} onChange={(e) => setS({ ...s, orphan_after_s: e.target.value })} /></Field>
        {s.type === 'docker' && <>
          <Field className="span2" label="Docker-Endpunkt" hint="unix:///var/run/docker.sock oder tcp://host:2375 (Docker-API nur im vertrauenswürdigen Netz freigeben)"><input value={s.config.endpoint ?? ''} onChange={(e) => c('endpoint', e.target.value)} /></Field>
          <Field label="Hostname überschreiben" hint="optional"><input value={s.config.host_name ?? ''} onChange={(e) => c('host_name', e.target.value || undefined)} /></Field>
          <label className="check"><input type="checkbox" checked={s.config.include_stopped !== false} onChange={(e) => c('include_stopped', e.target.checked)} />Gestoppte Container einbeziehen</label>
        </>}
        {s.type === 'network' && <>
          <Field className="span2" label="Netzbereiche (CIDR, kommagetrennt)" hint="max. 1024 Adressen je Bereich"><input value={list.cidrs} onChange={(e) => setList({ ...list, cidrs: e.target.value })} placeholder="192.168.1.0/24" /></Field>
          <Field className="span2" label="Ausnehmen (IPs/CIDR)"><input value={list.exclude} onChange={(e) => setList({ ...list, exclude: e.target.value })} /></Field>
          <Field label="Ports" hint="leer = Standardliste (22, 53, 80, 443, …)"><input value={list.ports} onChange={(e) => setList({ ...list, ports: e.target.value })} /></Field>
          <Field label="Timeout je Port (ms)"><input type="number" value={s.config.timeout_ms ?? 400} onChange={(e) => c('timeout_ms', Number(e.target.value))} /></Field>
        </>}
        {s.type === 'host' && <label className="check span2"><input type="checkbox" checked={s.config.systemd !== false} onChange={(e) => c('systemd', e.target.checked)} />Aktive systemd-Dienste erkennen (über /run/systemd/units des Hosts)</label>}
        <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />Quelle aktiv</label>
      </div>
    </Modal>
  );
}
