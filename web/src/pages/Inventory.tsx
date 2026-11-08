import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { ago } from '../lib/format';
import { useAuth } from '../lib/auth';
import { CRIT_LABEL, CRITS, DISCOVERY_LABEL, KIND_LABEL, STATUS_RANK, STATUSES } from '../lib/meta';
import { Badge, Empty, Icon, Modal, StatusBadge, Tags, useToast, Field } from '../components/ui';
import { ResourceForm, ResourceDraft } from '../components/ResourceForm';
import { BulkDependencyDialog } from '../components/BulkDependencyDialog';
import { STATUS_LABEL } from '../lib/format';

type R = Record<string, any>;
const FILTERS: Array<{ key: string; label: string; get: (r: R) => string | string[] | null; fmt?: (v: string) => string }> = [
  { key: 'status', label: 'Status', get: (r) => r.status, fmt: (v) => STATUS_LABEL[v] ?? v },
  { key: 'kind', label: 'Typ', get: (r) => r.kind, fmt: (v) => KIND_LABEL[v] ?? v },
  { key: 'host', label: 'Host', get: (r) => r.parent_name ?? (r.kind === 'host' ? r.label : null) },
  { key: 'compose', label: 'Compose-Projekt', get: (r) => r.compose_project },
  { key: 'env', label: 'Umgebung', get: (r) => r.environment },
  { key: 'group', label: 'Gruppe', get: (r) => r.group_name },
  { key: 'crit', label: 'Kritikalität', get: (r) => r.criticality, fmt: (v) => CRIT_LABEL[v] ?? v },
  { key: 'owner', label: 'Verantwortlich', get: (r) => r.owner },
  { key: 'tag', label: 'Tag', get: (r) => r.tags },
  { key: 'origin', label: 'Erkennung', get: (r) => r.origin, fmt: (v) => (v === 'auto' ? 'automatisch' : 'manuell') },
  { key: 'mon', label: 'Überwachung', get: (r) => (r.monitoring_enabled ? 'an' : 'aus') },
  { key: 'disc', label: 'Discovery', get: (r) => r.discovery_status, fmt: (v) => DISCOVERY_LABEL[v] ?? v },
];
const GROUPS: Record<string, string> = { '': 'Keine Gruppierung', host: 'Host', kind: 'Typ', compose: 'Compose-Projekt', env: 'Umgebung', group: 'Gruppe', status: 'Status', crit: 'Kritikalität', owner: 'Verantwortlich', origin: 'Erkennung' };
const COLS: Array<{ key: string; label: string; sort: (r: R) => any }> = [
  { key: 'status', label: 'Status', sort: (r) => -(STATUS_RANK[r.status] ?? 0) },
  { key: 'name', label: 'Name', sort: (r) => r.label.toLowerCase() },
  { key: 'kind', label: 'Typ', sort: (r) => r.kind },
  { key: 'host', label: 'Host', sort: (r) => r.parent_name ?? '' },
  { key: 'compose', label: 'Compose', sort: (r) => r.compose_project ?? '' },
  { key: 'env', label: 'Umgebung', sort: (r) => r.environment ?? '' },
  { key: 'crit', label: 'Krit.', sort: (r) => -CRITS.indexOf(r.criticality) },
  { key: 'owner', label: 'Verantw.', sort: (r) => r.owner ?? '' },
  { key: 'tags', label: 'Tags', sort: (r) => (r.tags ?? []).join(',') },
  { key: 'origin', label: 'Erkennung', sort: (r) => r.origin },
  { key: 'mon', label: 'Überw.', sort: (r) => (r.monitoring_enabled ? 0 : 1) },
  { key: 'change', label: 'Letzte Änderung', sort: (r) => -new Date(r.last_change_at).getTime() },
];

export default function Inventory() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const res = useQuery({ queryKey: ['resources'], queryFn: () => get<R[]>('/resources'), refetchInterval: 30000 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [bulkSet, setBulkSet] = useState(false);
  const [bulkDeps, setBulkDeps] = useState(false);
  const view = params.get('view') ?? 'all';
  const search = params.get('q') ?? '';
  const sortKey = params.get('sort') ?? 'status';
  const sortDir = params.get('dir') === 'desc' ? -1 : 1;
  const groupBy = params.get('group') ?? '';

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v === null || v === '') p.delete(k); else p.set(k, v);
    setParams(p, { replace: true });
  };

  const all = res.data ?? [];
  const options = useMemo(() => {
    const o: Record<string, string[]> = {};
    for (const f of FILTERS) {
      const s = new Set<string>();
      for (const r of all) { const v = f.get(r); (Array.isArray(v) ? v : [v]).forEach((x) => x && s.add(x)); }
      o[f.key] = [...s].sort();
    }
    return o;
  }, [all]);

  const rows = useMemo(() => {
    let list = all;
    if (view === 'orphaned') list = list.filter((r) => r.discovery_status === 'orphaned' || r.discovery_status === 'missing');
    if (search) {
      const s = search.toLowerCase();
      list = list.filter((r) => [r.label, r.name, r.identity_key, r.parent_name, r.compose_project, r.owner, r.group_name, r.environment, ...(r.tags ?? []), r.connection?.host, r.connection?.url, r.discovered?.image]
        .some((v) => v && String(v).toLowerCase().includes(s)));
    }
    for (const f of FILTERS) {
      const want = params.get(f.key);
      if (!want) continue;
      list = list.filter((r) => { const v = f.get(r); return Array.isArray(v) ? v.includes(want) : v === want; });
    }
    const col = COLS.find((c) => c.key === sortKey) ?? COLS[0];
    return [...list].sort((a, b) => {
      const x = col.sort(a), y = col.sort(b);
      return (x < y ? -1 : x > y ? 1 : a.label.localeCompare(b.label)) * sortDir;
    });
  }, [all, params, view, search, sortKey, sortDir]);

  const grouped = useMemo(() => {
    if (!groupBy) return [['', rows]] as [string, R[]][];
    const f = FILTERS.find((x) => x.key === groupBy)!;
    const m = new Map<string, R[]>();
    for (const r of rows) {
      const v = f.get(r);
      const keys = Array.isArray(v) ? (v.length ? v : ['–']) : [v ?? '–'];
      for (const k of keys) m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [f.fmt && k !== '–' ? f.fmt(k) : k, v]) as [string, R[]][];
  }, [rows, groupBy]);

  const create = useMutation({
    mutationFn: (d: ResourceDraft) => post('/resources', d),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['resources'] }); setCreating(false); toast('Ressource angelegt'); nav(`/resources/${r.id}`); },
    onError: (e: Error) => toast(e.message, true),
  });
  const bulk = useMutation({
    mutationFn: (b: any) => post('/resources/bulk', { ids: [...selected], ...b }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['resources'] }); setSelected(new Set()); setBulkSet(false); toast('Änderung übernommen'); },
    onError: (e: Error) => toast(e.message, true),
  });

  const toggle = (id: string) => { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s); };
  const orphanCount = all.filter((r) => r.discovery_status === 'orphaned' || r.discovery_status === 'missing').length;
  const activeFilters = FILTERS.filter((f) => params.get(f.key));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Inventar</h1><span className="sub">{rows.length} von {all.length} Ressourcen</span>
        <div className="actions">{can('operator') && <button className="primary" onClick={() => setCreating(true)}><Icon name="plus" />Ressource anlegen</button>}</div>
      </div>
      <div className="toolbar">
        <div className="tabs">
          <button className={`tab ${view === 'all' ? 'active' : ''}`} onClick={() => setParam('view', null)}>Alle<span className="n">{all.length}</span></button>
          <button className={`tab ${view === 'orphaned' ? 'active' : ''}`} onClick={() => setParam('view', 'orphaned')}>Fehlend / verwaist<span className="n">{orphanCount}</span></button>
          <button className={`tab ${view === 'duplicates' ? 'active' : ''}`} onClick={() => setParam('view', 'duplicates')}>Duplikate</button>
        </div>
        <div className="spacer" />
        <div className="search"><Icon name="search" /><input placeholder="Name, Image, Adresse, Tag suchen" value={search} onChange={(e) => setParam('q', e.target.value)} /></div>
      </div>
      {view === 'duplicates' ? <Duplicates /> : (
        <>
          <div className="toolbar">
            {FILTERS.map((f) => (
              <select key={f.key} value={params.get(f.key) ?? ''} onChange={(e) => setParam(f.key, e.target.value)} style={{ maxWidth: 170, color: params.get(f.key) ? 'var(--text)' : 'var(--muted)' }} aria-label={f.label}>
                <option value="">{f.label}: alle</option>
                {(f.key === 'status' ? STATUSES.filter((s) => options.status.includes(s)) : options[f.key]).map((v) => <option key={v} value={v}>{f.label}: {f.fmt ? f.fmt(v) : v}</option>)}
              </select>
            ))}
            {activeFilters.length > 0 && <button className="ghost sm" onClick={() => { const p = new URLSearchParams(); if (params.get('view')) p.set('view', params.get('view')!); setParams(p); }}>Filter zurücksetzen</button>}
            <div className="spacer" />
            <select value={groupBy} onChange={(e) => setParam('group', e.target.value)} aria-label="Gruppierung">{Object.entries(GROUPS).map(([k, l]) => <option key={k} value={k}>{k ? `Gruppieren: ${l}` : l}</option>)}</select>
          </div>
          {selected.size > 0 && can('operator') && (
            <div className="toolbar callout" style={{ padding: '6px 10px' }}>
              <span>{selected.size} ausgewählt</span>
              <button className="sm" onClick={() => bulk.mutate({ action: 'enable_monitoring' })}>Überwachung an</button>
              <button className="sm" onClick={() => bulk.mutate({ action: 'disable_monitoring' })}>Überwachung aus</button>
              <button className="sm" onClick={() => setBulkSet(true)}>Felder setzen</button>
              <button className="sm" onClick={() => setBulkDeps(true)}><Icon name="share" size={12} />Abhängigkeit setzen</button>
              <button className="sm danger" onClick={() => confirm(`${selected.size} Ressourcen löschen? Entdeckte Ressourcen landen wieder in der Discovery-Inbox.`) && bulk.mutate({ action: 'delete' })}>Löschen</button>
              <button className="ghost sm" onClick={() => setSelected(new Set())}>Auswahl aufheben</button>
            </div>
          )}
          <div className="panel flush table-wrap">
            {res.isLoading ? <Empty>Lade Inventar…</Empty> : rows.length === 0 ? (
              <Empty>{all.length === 0 ? 'Noch keine Ressourcen. Die Discovery läuft im Hintergrund; neue Funde erscheinen in der Discovery-Inbox.' : 'Keine Ressource passt zu den Filtern.'}</Empty>
            ) : (
              <table className="t">
                <thead><tr>
                  <th style={{ width: 28 }}><input type="checkbox" aria-label="Alle auswählen" checked={rows.length > 0 && rows.every((r) => selected.has(r.id))} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                  {COLS.map((c) => <th key={c.key} className="sortable" onClick={() => { if (sortKey === c.key) setParam('dir', sortDir === 1 ? 'desc' : null); else { setParam('sort', c.key); } }}>
                    {c.label}{sortKey === c.key ? (sortDir === 1 ? ' ↑' : ' ↓') : ''}</th>)}
                </tr></thead>
                <tbody>
                  {grouped.map(([g, list]) => [
                    g ? <tr key={`g-${g}`} className="group"><td colSpan={COLS.length + 1}>{g} <span className="dim">· {list.length}</span></td></tr> : null,
                    ...list.map((r) => (
                      <tr key={`${g}-${r.id}`} className="click" onClick={() => nav(`/resources/${r.id}`)}>
                        <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`${r.label} auswählen`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                        <td><StatusBadge status={r.status} />{r.root_cause_ids?.length > 0 && <> <Badge kind="impacted">Folgefehler</Badge></>}{r.in_maintenance && <> <Badge kind="maint">Wartung</Badge></>}</td>
                        <td style={{ maxWidth: 280 }}><div style={{ fontWeight: 500 }}>{r.label}</div>{r.discovered?.image && <div className="dim mono" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.discovered.image}</div>}</td>
                        <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                        <td className="dim">{r.parent_name ?? '–'}</td>
                        <td className="mono dim">{r.compose_project ?? '–'}</td>
                        <td>{r.environment ?? <span className="dim">–</span>}</td>
                        <td><Badge kind={r.criticality === 'critical' ? 'critical' : r.criticality === 'high' ? 'warning' : ''}>{CRIT_LABEL[r.criticality]}</Badge></td>
                        <td className="dim">{r.owner ?? '–'}</td>
                        <td><Tags tags={r.tags} /></td>
                        <td>{r.origin === 'auto' ? <span title={r.source_name}>auto</span> : 'manuell'}{r.discovery_status && r.discovery_status !== 'active' && <> <Badge kind={r.discovery_status === 'orphaned' ? 'critical' : 'warning'}>{DISCOVERY_LABEL[r.discovery_status]}</Badge></>}</td>
                        <td>{r.monitoring_enabled ? <Badge kind="ok">an</Badge> : <Badge>aus</Badge>}</td>
                        <td className="dim" title={r.last_change_at}>{ago(r.last_change_at)}</td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
      {creating && <ResourceForm initial={{ name: '', kind: 'service', criticality: 'medium', tags: [], connection: {}, monitoring_enabled: true }} onClose={() => setCreating(false)} onSave={(d) => create.mutate(d)} busy={create.isPending} />}
      {bulkDeps && <BulkDependencyDialog ids={[...selected]} onClose={() => setBulkDeps(false)} onDone={() => { setBulkDeps(false); setSelected(new Set()); }} />}
      {bulkSet && <BulkSet onClose={() => setBulkSet(false)} onSave={(set) => bulk.mutate({ action: 'set', set })} />}
    </div>
  );
}

function BulkSet({ onClose, onSave }: { onClose: () => void; onSave: (s: any) => void }) {
  const [s, setS] = useState<any>({});
  return (
    <Modal title="Felder für Auswahl setzen" onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={() => {
      const out: any = {};
      for (const [k, v] of Object.entries(s)) if (v !== '' && v !== undefined) out[k] = k === 'add_tags' ? String(v).split(',').map((t) => t.trim()).filter(Boolean) : v;
      onSave(out);
    }}>Übernehmen</button></>}>
      <div className="sub">Leere Felder bleiben unverändert.</div>
      <div className="form-grid">
        <Field label="Umgebung"><input onChange={(e) => setS({ ...s, environment: e.target.value })} /></Field>
        <Field label="Gruppe"><input onChange={(e) => setS({ ...s, group_name: e.target.value })} /></Field>
        <Field label="Kritikalität"><select onChange={(e) => setS({ ...s, criticality: e.target.value || undefined })}><option value="">unverändert</option>{CRITS.map((c) => <option key={c} value={c}>{CRIT_LABEL[c]}</option>)}</select></Field>
        <Field label="Verantwortlich"><input onChange={(e) => setS({ ...s, owner: e.target.value })} /></Field>
        <Field className="span2" label="Tags hinzufügen" hint="Kommagetrennt"><input onChange={(e) => setS({ ...s, add_tags: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function Duplicates() {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const dups = useQuery({ queryKey: ['resources', 'duplicates'], queryFn: () => get<any[]>('/resources/duplicates') });
  const merge = useMutation({
    mutationFn: ({ target, source }: { target: string; source: string }) => post(`/resources/${target}/merge`, { source_id: source }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['resources'] }); toast('Zusammengeführt'); },
    onError: (e: Error) => toast(e.message, true),
  });
  const dismiss = useMutation({ mutationFn: (key: string) => post('/resources/duplicates/dismiss', { key }), onSuccess: () => qc.invalidateQueries({ queryKey: ['resources', 'duplicates'] }) });
  if (dups.isLoading) return <Empty>Suche Duplikate…</Empty>;
  if (!dups.data?.length) return <div className="panel"><Empty>Keine wahrscheinlichen Duplikate gefunden.</Empty></div>;
  return (
    <div className="stack">
      <div className="sub">Mögliche Duplikate nach Container-ID, Adresse und ähnlichem Namen. Beim Zusammenführen bleibt die gewählte Ressource erhalten; Checks, Abhängigkeiten, Ereignisse, Tags und die Discovery-Identität der anderen gehen auf sie über.</div>
      {dups.data.map((g) => (
        <div key={g.key} className="panel">
          <div className="panel-head"><h2>{g.reason}</h2><div className="actions"><button className="ghost sm" onClick={() => dismiss.mutate(g.key)}>Kein Duplikat</button></div></div>
          <table className="t"><tbody>{g.resources.map((r: any) => (
            <tr key={r.id}><td><a onClick={() => nav(`/resources/${r.id}`)} style={{ cursor: 'pointer' }}>{r.label}</a></td><td>{KIND_LABEL[r.kind]}</td><td>{r.origin === 'auto' ? 'automatisch' : 'manuell'}</td>
              <td className="mono dim">{r.url ?? (r.host ? `${r.host}${r.port ? ':' + r.port : ''}` : '')}</td>
              <td style={{ textAlign: 'right' }}>{g.resources.filter((o: any) => o.id !== r.id).map((o: any) => (
                <button key={o.id} className="sm" onClick={() => confirm(`„${o.label}“ in „${r.label}“ zusammenführen? „${o.label}“ wird danach entfernt.`) && merge.mutate({ target: r.id, source: o.id })}>
                  <Icon name="merge" size={14} />„{o.label}“ hier zusammenführen</button>))}</td></tr>))}
          </tbody></table>
        </div>
      ))}
    </div>
  );
}
