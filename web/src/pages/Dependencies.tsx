import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DEP_TYPES, KIND_LABEL } from '../lib/meta';
import { Badge, Empty, Icon, StatusBadge, useToast } from '../components/ui';
import { Topology } from '../components/Topology';
import { DependencyDialog } from '../components/DependencyDialog';
import { SuggestionList, useSuggestions } from '../components/Suggestions';
import { useNavigate } from 'react-router-dom';

export default function Dependencies() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [tab, setTab] = useState<'graph' | 'list' | 'suggest'>('graph');
  const sugg = useSuggestions();
  const nav = useNavigate();
  const [dialog, setDialog] = useState<any | null>(null);
  const [selected, setSelected] = useState<any | null>(null);
  const [search, setSearch] = useState('');
  const [showSuppressed, setShowSuppressed] = useState(false);
  const graph = useQuery({ queryKey: ['graph'], queryFn: () => get('/graph'), refetchInterval: 20000 });
  const deps = useQuery({ queryKey: ['dependencies'], queryFn: () => get<any[]>('/dependencies') });
  const remove = useMutation({ mutationFn: (id: string) => del(`/dependencies/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['dependencies'] }); qc.invalidateQueries({ queryKey: ['graph'] }); toast('Abhängigkeit entfernt'); } });
  const restore = useMutation({ mutationFn: (id: string) => post(`/dependencies/${id}/restore`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['dependencies'] }); qc.invalidateQueries({ queryKey: ['graph'] }); } });
  // the editor graph shows everything that has at least one edge, plus infrastructure nodes
  const connected = useMemo(() => new Set((graph.data?.edges ?? []).flatMap((e: any) => [e.from_id, e.to_id])), [graph.data]);
  const filter = useMemo(() => (n: any) => (connected.has(n.id) || ['router', 'firewall', 'switch', 'wan', 'nas', 'access_point', 'dns', 'external_api', 'service', 'database', 'proxy', 'backup_job'].includes(n.kind))
    && (!search || n.label.toLowerCase().includes(search.toLowerCase())), [connected, search]);
  const list = (deps.data ?? []).filter((d) => (showSuppressed || !d.suppressed) && (!search || `${d.from_name} ${d.to_name}`.toLowerCase().includes(search.toLowerCase())));
  const selDeps = selected ? (deps.data ?? []).filter((d) => !d.suppressed && (d.from_id === selected.id || d.to_id === selected.id)) : [];
  return (
    <div className="page" style={{ maxWidth: 'none' }}>
      <div className="page-head">
        <h1>Abhängigkeiten</h1><span className="sub">Pfeil = „hängt ab von“. Fällt ein Anbieter aus, werden Folgefehler unterdrückt und nachgelagerte Komponenten als betroffen markiert.</span>
        <div className="actions">{can('operator') && <button className="primary" onClick={() => setDialog({})}><Icon name="plus" />Abhängigkeit anlegen</button>}</div>
      </div>
      <div className="toolbar">
        <div className="tabs"><button className={`tab ${tab === 'graph' ? 'active' : ''}`} onClick={() => setTab('graph')}>Graph</button><button className={`tab ${tab === 'list' ? 'active' : ''}`} onClick={() => setTab('list')}>Liste<span className="n">{deps.data?.filter((d) => !d.suppressed).length ?? 0}</span></button>
          <button className={`tab ${tab === 'suggest' ? 'active' : ''}`} onClick={() => setTab('suggest')}>Vorschläge<span className="n">{sugg.data?.length ?? 0}</span></button></div>
        {tab === 'graph' && can('operator') && <span className="sub">Verbinden: vom oberen Punkt „Abhängig von“ zum unteren Punkt „Sind abhängig von dieser Ressource“ des Anbieters ziehen (oder umgekehrt).</span>}
        <div className="spacer" />
        {tab === 'list' && <label className="check"><input type="checkbox" checked={showSuppressed} onChange={(e) => setShowSuppressed(e.target.checked)} />entfernte automatische anzeigen</label>}
        <div className="search"><Icon name="search" /><input placeholder="Komponente suchen" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>
      {tab === 'suggest' ? <SuggestionList onWalkthrough={() => nav('/?walkthrough=1')} /> : tab === 'graph' ? (
        <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 340px' : '1fr', gap: 12 }}>
          <div className="panel flush" style={{ height: 'calc(100vh - 200px)', overflow: 'hidden' }}>
            {graph.data ? <Topology data={graph.data} filter={filter} selectedId={selected?.id} onSelect={setSelected}
              onConnect={can('operator') ? (from, to) => setDialog({ from_id: from, to_id: to }) : undefined} /> : <Empty>Lade Graph…</Empty>}
          </div>
          {selected && (
            <div className="panel" style={{ alignSelf: 'start' }}>
              <div className="panel-head"><h2 style={{ margin: 0 }}>{selected.label}</h2><div className="actions"><button className="ghost sm" onClick={() => setSelected(null)}><Icon name="x" /></button></div></div>
              <div className="row" style={{ marginBottom: 10 }}><StatusBadge status={selected.status} /><span className="sub">{KIND_LABEL[selected.kind]}</span><Link to={`/resources/${selected.id}`} style={{ marginLeft: 'auto' }}>Details</Link></div>
              <h3>Hängt ab von</h3>
              {selDeps.filter((d) => d.from_id === selected.id).map((d) => <DepRow key={d.id} d={d} other="to" onDelete={can('operator') ? () => remove.mutate(d.id) : undefined} onEdit={() => setDialog(d)} />)}
              {!selDeps.some((d) => d.from_id === selected.id) && <div className="dim" style={{ fontSize: 12.5 }}>–</div>}
              <h3 style={{ marginTop: 12 }}>Wird benötigt von</h3>
              {selDeps.filter((d) => d.to_id === selected.id).map((d) => <DepRow key={d.id} d={d} other="from" onDelete={can('operator') ? () => remove.mutate(d.id) : undefined} onEdit={() => setDialog(d)} />)}
              {!selDeps.some((d) => d.to_id === selected.id) && <div className="dim" style={{ fontSize: 12.5 }}>–</div>}
              {can('operator') && <div className="row" style={{ marginTop: 12 }}><button className="sm" onClick={() => setDialog({ from_id: selected.id })}>Anbieter hinzufügen</button><button className="sm" onClick={() => setDialog({ to_id: selected.id })}>Abhängige hinzufügen</button></div>}
            </div>
          )}
        </div>
      ) : (
        <div className="panel flush table-wrap">
          {list.length === 0 ? <Empty>Keine Abhängigkeiten.</Empty> : (
            <table className="t">
              <thead><tr><th>Komponente</th><th>Art</th><th>Anbieter</th><th>Stärke</th><th>Netz / VLAN</th><th>Herkunft</th><th /></tr></thead>
              <tbody>{list.map((d) => (
                <tr key={d.id} style={{ opacity: d.suppressed ? 0.5 : 1 }}>
                  <td><StatusBadge status={d.from_status} label="" /> <Link to={`/resources/${d.from_id}`}>{d.from_name}</Link> <span className="dim">{KIND_LABEL[d.from_kind]}</span></td>
                  <td>{DEP_TYPES[d.type] ?? d.type}</td>
                  <td><StatusBadge status={d.to_status} label="" /> <Link to={`/resources/${d.to_id}`}>{d.to_name}</Link> <span className="dim">{KIND_LABEL[d.to_kind]}</span></td>
                  <td>{d.strength === 'hard' ? 'hart' : 'weich'}</td>
                  <td className="mono dim">{[d.attributes?.network, d.attributes?.subnet, d.attributes?.vlan && `VLAN ${d.attributes.vlan}`, d.attributes?.port].filter(Boolean).join(' · ') || '–'}</td>
                  <td>{d.origin === 'auto' ? <Badge kind="info">automatisch</Badge> : 'manuell'}{d.suppressed && <> <Badge>entfernt</Badge></>}</td>
                  <td style={{ textAlign: 'right' }}>{can('operator') && (d.suppressed ? <button className="sm" onClick={() => restore.mutate(d.id)}>Wiederherstellen</button> : <>
                    <button className="sm" onClick={() => setDialog(d)}>Bearbeiten</button> <button className="sm danger" onClick={() => remove.mutate(d.id)}>Entfernen</button></>)}</td>
                </tr>))}</tbody>
            </table>
          )}
        </div>
      )}
      {dialog && <DependencyDialog initial={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function DepRow({ d, other, onDelete, onEdit }: { d: any; other: 'from' | 'to'; onDelete?: () => void; onEdit: () => void }) {
  return (
    <div className="row" style={{ padding: '4px 0', fontSize: 13 }}>
      <StatusBadge status={d[`${other}_status`]} label="" />
      <Link to={`/resources/${d[`${other}_id`]}`}>{d[`${other}_name`]}</Link>
      <span className="dim" style={{ fontSize: 11.5 }}>{DEP_TYPES[d.type]}{d.strength === 'soft' ? ', weich' : ''}</span>
      {onDelete && <span style={{ marginLeft: 'auto' }} className="row"><button className="ghost sm" onClick={onEdit}>Bearb.</button><button className="ghost sm" onClick={onDelete}><Icon name="x" size={12} /></button></span>}
    </div>
  );
}
