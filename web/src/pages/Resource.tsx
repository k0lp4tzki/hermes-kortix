import { ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../lib/api';
import { ago, ts } from '../lib/format';
import { useAuth } from '../lib/auth';
import { CRIT_LABEL, DISCOVERY_LABEL, KIND_LABEL } from '../lib/meta';
import { Badge, Empty, Icon, StatusBadge, Tags, useToast } from '../components/ui';
import { ResourceForm } from '../components/ResourceForm';
import { EventFeed } from '../components/EventFeed';
import { resourceTabs } from './resourceTabs';

export default function ResourcePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const r = useQuery({ queryKey: ['resource', id], queryFn: () => get(`/resources/${id}`), refetchInterval: 15000 });
  const update = useMutation({
    mutationFn: (b: any) => patch(`/resources/${id}`, b),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['resource', id] }); qc.invalidateQueries({ queryKey: ['resources'] }); setEditing(false); toast('Gespeichert'); },
    onError: (e: Error) => toast(e.message, true),
  });
  const remove = useMutation({ mutationFn: () => del(`/resources/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['resources'] }); nav('/inventory'); toast('Ressource gelöscht'); } });
  const detach = useMutation({ mutationFn: () => post(`/resources/${id}/detach`), onSuccess: () => qc.invalidateQueries({ queryKey: ['resource', id] }) });
  const unlock = useMutation({ mutationFn: (field: string) => post(`/resources/${id}/unlock`, { field }), onSuccess: () => qc.invalidateQueries({ queryKey: ['resource', id] }) });

  if (r.isLoading) return <div className="page"><Empty>Lade…</Empty></div>;
  if (r.error || !r.data) return <div className="page"><Empty>Ressource nicht gefunden. <Link to="/inventory">Zum Inventar</Link></Empty></div>;
  const d = r.data;
  const tabs: Array<[string, string, ReactNode]> = [
    ['overview', 'Übersicht', <Overview d={d} onUnlock={(f) => unlock.mutate(f)} />],
    ...resourceTabs(d),
    ['events', 'Ereignisse', <div className="panel"><EventFeed resourceId={d.id} limit={300} showResource={false} /></div>],
  ];
  return (
    <div className="page">
      <div className="sub" style={{ marginBottom: 6 }}><Link to="/inventory">Inventar</Link>{d.parent_id && <> / <Link to={`/resources/${d.parent_id}`}>{d.parent_name}</Link></>}</div>
      <div className="page-head">
        <h1>{d.label}</h1>
        <StatusBadge status={d.status} />
        {d.root_cause_ids?.length > 0 && <Badge kind="impacted">Folgefehler</Badge>}
        {d.in_maintenance && <Badge kind="maint">Wartung</Badge>}
        <span className="sub">{KIND_LABEL[d.kind] ?? d.kind} · seit {ago(d.status_since)}</span>
        <div className="actions">
          {can('operator') && <>
            <button onClick={() => update.mutate({ monitoring_enabled: !d.monitoring_enabled })}>{d.monitoring_enabled ? 'Überwachung deaktivieren' : 'Überwachung aktivieren'}</button>
            <button onClick={() => setEditing(true)}><Icon name="wrench" />Bearbeiten</button>
            {d.origin === 'auto' && <button className="ghost" title="Discovery verwaltet diese Ressource danach nicht mehr" onClick={() => confirm('Von der Discovery lösen? Die Ressource wird danach nur noch manuell gepflegt.') && detach.mutate()}>Von Discovery lösen</button>}
            <button className="danger" onClick={() => confirm(`„${d.label}“ löschen? Checks, Messwerte und Ereignisse werden mit gelöscht.`) && remove.mutate()}><Icon name="trash" /></button>
          </>}
        </div>
      </div>
      {d.status_message && <div className={`callout ${d.status === 'critical' ? 'crit' : d.status === 'warning' ? 'warn' : ''}`} style={{ marginBottom: 12 }}>{d.status_message}</div>}
      <div className="toolbar"><div className="tabs">{tabs.map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div></div>
      {tabs.find(([k]) => k === tab)?.[2]}
      {editing && <ResourceForm initial={{ ...d, tags: d.tags ?? [] }} onClose={() => setEditing(false)} busy={update.isPending}
        onSave={(x) => update.mutate({ name: x.name, display_name: x.display_name, kind: x.kind, parent_id: x.parent_id ?? null, environment: x.environment, group_name: x.group_name, criticality: x.criticality, owner: x.owner, tags: x.tags, connection: x.connection, notes: x.notes ?? null, metadata: x.metadata })} />}
    </div>
  );
}

function Overview({ d, onUnlock }: { d: any; onUnlock: (f: string) => void }) {
  const locked = new Set<string>(d.locked_fields ?? []);
  const L = ({ f }: { f: string }) => (locked.has(f) && d.origin === 'auto' ? <button className="ghost sm" title="Manuell gesetzt – Discovery überschreibt nicht. Klicken, um wieder der Discovery zu überlassen." onClick={() => onUnlock(f)}><Icon name="key" size={12} /></button> : null);
  const disc = d.discovered ?? {};
  return (
    <div className="grid2">
      <div className="panel">
        <h2>Stammdaten</h2>
        <dl className="kv">
          <dt>Interne ID</dt><dd className="mono">{d.id}</dd>
          <dt>Name</dt><dd>{d.name} <L f="name" /></dd>
          {d.display_name && <><dt>Anzeigename</dt><dd>{d.display_name}</dd></>}
          <dt>Typ</dt><dd>{KIND_LABEL[d.kind] ?? d.kind}</dd>
          <dt>Übergeordnet</dt><dd>{d.parent_id ? <Link to={`/resources/${d.parent_id}`}>{d.parent_name}</Link> : '–'} <L f="parent_id" /></dd>
          <dt>Umgebung</dt><dd>{d.environment ?? '–'}</dd>
          <dt>Gruppe</dt><dd>{d.group_name ?? '–'}</dd>
          <dt>Kritikalität</dt><dd>{CRIT_LABEL[d.criticality]}</dd>
          <dt>Verantwortlich</dt><dd>{d.owner ?? '–'}</dd>
          <dt>Tags</dt><dd><Tags tags={d.tags} />{!d.tags?.length && '–'}</dd>
          {Object.entries(d.metadata ?? {}).map(([k, v]) => <><dt key={k}>{k}</dt><dd key={k + 'v'}>{String(v)}</dd></>)}
          <dt>Verbindung</dt><dd className="mono">{Object.entries(d.connection ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`).join('  ') || '–'} <L f="connection" /></dd>
          <dt>Überwachung</dt><dd>{d.monitoring_enabled ? <Badge kind="ok">aktiv</Badge> : <Badge>deaktiviert</Badge>} <span className="dim">{d.active_check_count} von {d.check_count} Checks aktiv</span></dd>
          <dt>Letzter OK-Check</dt><dd>{d.last_ok_at ? `${ago(d.last_ok_at)} (${ts(d.last_ok_at)})` : '–'}</dd>
          {d.notes && <><dt>Notizen</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{d.notes}</dd></>}
        </dl>
      </div>
      <div className="stack">
        <div className="panel">
          <h2>Erkennung</h2>
          <dl className="kv">
            <dt>Herkunft</dt><dd>{d.origin === 'auto' ? 'automatisch erkannt' : 'manuell angelegt'}{d.source_name && <span className="dim"> · {d.source_name}</span>}</dd>
            {d.discovery_status && <><dt>Discovery-Status</dt><dd><Badge kind={d.discovery_status === 'active' ? 'ok' : d.discovery_status === 'orphaned' ? 'critical' : 'warning'}>{DISCOVERY_LABEL[d.discovery_status]}</Badge></dd></>}
            {d.identity_key && <><dt>Identität</dt><dd className="mono" style={{ fontSize: 11.5 }}>{d.identity_key}</dd></>}
            {d.aliases?.map((a: any) => <><dt key={a.identity_key}>Zusammengeführt</dt><dd className="mono" style={{ fontSize: 11.5 }}>{a.identity_key}</dd></>)}
            <dt>Zuerst gesehen</dt><dd>{ts(d.first_seen_at)}</dd>
            <dt>Zuletzt gesehen</dt><dd>{d.last_seen_at ? `${ago(d.last_seen_at)}` : '–'}</dd>
            <dt>Letzte Änderung</dt><dd>{ago(d.last_change_at)}</dd>
          </dl>
        </div>
        {Object.keys(disc).length > 0 && (
          <div className="panel">
            <h2>Erkannte Eigenschaften</h2>
            <dl className="kv">
              {Object.entries(disc).filter(([k, v]) => !['labels', 'parent_key', 'depends_on'].includes(k) && v !== null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => (
                <><dt key={k}>{k}</dt><dd key={k + 'v'} className="mono" style={{ fontSize: 11.5 }}>{k === 'mem_total' || k === 'mem_limit' ? `${(Number(v) / 1024 ** 3).toFixed(1)} GiB` : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></>
              ))}
            </dl>
            {disc.labels && Object.keys(disc.labels).length > 0 && <details style={{ marginTop: 8 }}><summary className="sub" style={{ cursor: 'pointer' }}>{Object.keys(disc.labels).length} Labels</summary>
              <pre className="mono" style={{ fontSize: 11, maxHeight: 220, overflow: 'auto' }}>{Object.entries(disc.labels).map(([k, v]) => `${k}=${v}`).join('\n')}</pre></details>}
          </div>
        )}
        {d.children?.length > 0 && (
          <div className="panel">
            <h2>Enthält ({d.children.length})</h2>
            {d.children.map((c: any) => <div key={c.id} className="row" style={{ padding: '3px 0' }}><StatusBadge status={c.status} /><Link to={`/resources/${c.id}`}>{c.label}</Link><span className="dim">{KIND_LABEL[c.kind]}</span></div>)}
          </div>
        )}
      </div>
    </div>
  );
}
