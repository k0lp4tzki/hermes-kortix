import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../lib/api';
import { ago, dur, ts } from '../lib/format';
import { useAuth } from '../lib/auth';
import { KIND_LABEL } from '../lib/meta';
import { Badge, Empty, Field, Icon, Modal, StatusBadge, useToast } from '../components/ui';

export default function Alerts() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'open';
  const incidentId = params.get('incident');
  const incidents = useQuery({ queryKey: ['incidents', 'list'], queryFn: () => get<any[]>('/incidents?limit=500'), refetchInterval: 15000 });
  const open = (incidents.data ?? []).filter((i) => i.status === 'open');
  const resolved = (incidents.data ?? []).filter((i) => i.status === 'resolved');
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p); };
  return (
    <div className="page">
      <div className="page-head"><h1>Alarme & Störungen</h1><span className="sub">Eine Störung pro Ursache; Folgefehler werden ihr zugeordnet und nicht separat gemeldet.</span></div>
      <div className="toolbar"><div className="tabs">
        <button className={`tab ${tab === 'open' ? 'active' : ''}`} onClick={() => set('tab', null)}>Offen<span className="n">{open.length}</span></button>
        <button className={`tab ${tab === 'resolved' ? 'active' : ''}`} onClick={() => set('tab', 'resolved')}>Behoben<span className="n">{resolved.length}</span></button>
        <button className={`tab ${tab === 'maintenance' ? 'active' : ''}`} onClick={() => set('tab', 'maintenance')}>Wartung & Stummschaltung</button>
      </div></div>
      {tab === 'maintenance' ? <Maintenance /> : <IncidentTable list={tab === 'open' ? open : resolved} loading={incidents.isLoading} onOpen={(id) => set('incident', id)} resolved={tab === 'resolved'} />}
      {incidentId && <IncidentDetail id={incidentId} onClose={() => set('incident', null)} />}
    </div>
  );
}

export function IncidentTable({ list, loading, onOpen, resolved, compact }: { list: any[]; loading?: boolean; onOpen: (id: string) => void; resolved?: boolean; compact?: boolean }) {
  if (loading) return <Empty>Lade…</Empty>;
  if (!list.length) return <div className={compact ? '' : 'panel'}><Empty>{resolved ? 'Keine behobenen Störungen.' : 'Keine offenen Störungen. Alles im grünen Bereich.'}</Empty></div>;
  return (
    <div className={compact ? '' : 'panel flush table-wrap'}>
      <table className="t">
        <thead><tr><th>Schwere</th><th>Störung</th>{!compact && <th>Ursache</th>}<th>Seit</th><th>Dauer</th>{!compact && <th>Häufigkeit</th>}<th>Betroffen</th>{!compact && <th>Status</th>}</tr></thead>
        <tbody>{list.map((i) => (
          <tr key={i.id} className="click" onClick={() => onOpen(i.id)}>
            <td><StatusBadge status={i.status === 'resolved' ? 'ok' : i.severity} label={i.status === 'resolved' ? 'behoben' : undefined} /></td>
            <td style={{ maxWidth: 520 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</div>{i.summary && <div className="dim" style={{ fontSize: 11.5 }}>{i.summary}</div>}</td>
            {!compact && <td>{i.resource_name ?? '–'} <span className="dim">{KIND_LABEL[i.resource_kind] ?? ''}</span></td>}
            <td className="dim" title={ts(i.opened_at)}>{ago(i.opened_at)}</td>
            <td className="num">{dur(((i.resolved_at ? new Date(i.resolved_at).getTime() : Date.now()) - new Date(i.opened_at).getTime()) / 1000)}</td>
            {!compact && <td className="num">{i.occurrences_7d}× / 7 T</td>}
            <td className="num">{i.affected_ids?.length ?? 0}{i.suppressed_ids?.length ? <span className="dim"> (+{i.suppressed_ids.length} Folgef.)</span> : ''}</td>
            {!compact && <td>{i.flapping && <Badge kind="warning">flattert</Badge>} {i.in_maintenance && <Badge kind="maint">Wartung</Badge>} {i.acknowledged_by && <Badge kind="info">bestätigt</Badge>} {i.notifications_sent > 0 && <span className="dim" style={{ fontSize: 11.5 }}>{i.notifications_sent} gesendet</span>}</td>}
          </tr>))}</tbody>
      </table>
    </div>
  );
}

export function IncidentDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const i = useQuery({ queryKey: ['incident', id], queryFn: () => get(`/incidents/${id}`), refetchInterval: 15000 });
  const ack = useMutation({ mutationFn: () => post(`/incidents/${id}/ack`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['incident'] }); qc.invalidateQueries({ queryKey: ['incidents'] }); toast('Bestätigt'); }, onError: (e: Error) => toast(e.message, true) });
  const d = i.data;
  return (
    <Modal title="Störung" wide onClose={onClose} footer={d && d.status === 'open' && !d.acknowledged_by && can('operator') ? <button className="primary" onClick={() => ack.mutate()}>Bestätigen (keine Erinnerungen mehr)</button> : undefined}>
      {!d ? <Empty>Lade…</Empty> : (
        <>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <StatusBadge status={d.status === 'resolved' ? 'ok' : d.severity} label={d.status === 'resolved' ? 'behoben' : undefined} />
            {d.flapping && <Badge kind="warning">flattert</Badge>}{d.in_maintenance && <Badge kind="maint">Wartung</Badge>}{d.acknowledged_by && <Badge kind="info">bestätigt von {d.acknowledged_by}</Badge>}
            <b style={{ fontSize: 15 }}>{d.title}</b>
          </div>
          <dl className="kv">
            <dt>Ursache</dt><dd><Link to={`/resources/${d.resource_id}`} onClick={onClose}>{d.resource_name}</Link> <span className="dim">{KIND_LABEL[d.resource_kind]}</span></dd>
            <dt>Beginn</dt><dd>{ts(d.opened_at)} ({ago(d.opened_at)})</dd>
            {d.resolved_at && <><dt>Ende</dt><dd>{ts(d.resolved_at)} – {d.summary}</dd></>}
            <dt>Dauer</dt><dd>{dur(((d.resolved_at ? new Date(d.resolved_at).getTime() : Date.now()) - new Date(d.opened_at).getTime()) / 1000)}</dd>
            <dt>Höchste Schwere</dt><dd>{d.peak_severity}</dd>
            <dt>Häufigkeit</dt><dd>{d.occurrences_7d}. Störung dieser Ressource in 7 Tagen · {d.history.length} insgesamt</dd>
          </dl>
          {d.related.length > 0 && (
            <div>
              <h3>Betroffene nachgelagerte Komponenten ({d.affected_ids.length}){d.suppressed_ids.length > 0 && ` – davon ${d.suppressed_ids.length} mit unterdrückten Folgefehlern`}</h3>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{d.related.map((r: any) => (
                <Link key={r.id} to={`/resources/${r.id}`} onClick={onClose} className="badge" style={{ textDecoration: 'none' }}><span className={`dot ${r.status}`} />{r.name}{d.suppressed_ids.includes(r.id) && ' · Folgefehler'}</Link>))}</div>
            </div>
          )}
          <div className="grid2">
            <div>
              <h3>Verlauf & Änderungen</h3>
              <div className="feed" style={{ maxHeight: 320, overflow: 'auto' }}>{d.timeline.map((e: any) => (
                <div key={e.id} className="feed-item"><time title={ts(e.time)}>{new Date(e.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</time><span className={`dot ${e.severity === 'info' ? 'pending' : e.severity}`} style={{ marginTop: 4 }} />
                  <span className="msg">{e.resource_id !== d.resource_id && <b>{e.resource_name}: </b>}{e.message}</span></div>))}</div>
            </div>
            <div>
              <h3>Benachrichtigungen</h3>
              {d.notifications.length === 0 ? <div className="dim" style={{ fontSize: 12.5 }}>Keine. {d.status === 'open' && 'Ohne passende Routing-Regel wird nichts gesendet (Benachrichtigungen → Routing).'}</div> : (
                <div className="feed">{d.notifications.map((n: any) => (
                  <div key={n.id} className="feed-item"><time>{new Date(n.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</time><span className={`dot ${n.status === 'sent' ? 'ok' : n.status === 'failed' ? 'critical' : 'pending'}`} style={{ marginTop: 4 }} />
                    <span className="msg">{n.event} → {n.channel_name} <span className="dim">({n.status}{n.http_status ? ` HTTP ${n.http_status}` : ''}{n.reason ? `: ${n.reason}` : ''})</span></span></div>))}</div>
              )}
              <h3 style={{ marginTop: 12 }}>Frühere Störungen dieser Ressource</h3>
              <div className="feed">{d.history.slice(0, 8).map((h: any) => (
                <div key={h.id} className="feed-item"><time>{new Date(h.opened_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</time><span className={`dot ${h.status === 'open' ? h.severity : 'ok'}`} style={{ marginTop: 4 }} />
                  <span className="msg dim">{h.severity}, {dur(((h.resolved_at ? new Date(h.resolved_at).getTime() : Date.now()) - new Date(h.opened_at).getTime()) / 1000)}{h.id === d.id ? ' (diese)' : ''}</span></div>))}</div>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function Maintenance() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['maintenance'], queryFn: () => get<any[]>('/maintenance'), refetchInterval: 30000 });
  const [create, setCreate] = useState(false);
  const end = useMutation({ mutationFn: (id: string) => post(`/maintenance/${id}/end`), onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance'] }) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/maintenance/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance'] }), onError: (e: Error) => toast(e.message, true) });
  return (
    <>
      <div className="toolbar"><span className="sub">Während eines Wartungsfensters laufen Checks weiter und Störungen werden erfasst, aber nicht gemeldet.</span><div className="spacer" />
        {can('operator') && <button className="primary" onClick={() => setCreate(true)}><Icon name="plus" />Wartungsfenster planen</button>}</div>
      <div className="panel flush">
        {!list.data?.length ? <Empty>Keine aktuellen oder geplanten Wartungsfenster.</Empty> : (
          <table className="t">
            <thead><tr><th>Status</th><th>Name</th><th>Zeitraum</th><th>Umfang</th><th>Erstellt von</th><th /></tr></thead>
            <tbody>{list.data.map((m) => {
              const future = new Date(m.starts_at).getTime() > Date.now();
              const past = new Date(m.ends_at).getTime() <= Date.now();
              return (
                <tr key={m.id}>
                  <td>{m.active ? <Badge kind="maint">aktiv</Badge> : future ? <Badge kind="info">geplant</Badge> : <Badge>beendet</Badge>}</td>
                  <td>{m.name}{m.reason && <div className="dim" style={{ fontSize: 11.5 }}>{m.reason}</div>}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{ts(m.starts_at)} – {ts(m.ends_at)}</td>
                  <td>{[...(m.resource_names ?? []), ...m.match_tags.map((t: string) => `#${t}`)].join(', ')}{m.include_dependents && <span className="dim"> + abhängige</span>}</td>
                  <td className="dim">{m.created_by}</td>
                  <td style={{ textAlign: 'right' }}>{can('operator') && !past && <button className="sm" onClick={() => end.mutate(m.id)}>Jetzt beenden</button>} {can('operator') && <button className="sm danger" onClick={() => remove.mutate(m.id)}>Löschen</button>}</td>
                </tr>);
            })}</tbody>
          </table>
        )}
      </div>
      {create && <MaintenanceDialog onClose={() => setCreate(false)} />}
    </>
  );
}

export function MaintenanceDialog({ onClose, preset }: { onClose: () => void; preset?: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const res = useQuery({ queryKey: ['resources'], queryFn: () => get<any[]>('/resources') });
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [m, setM] = useState({ name: 'Wartung', reason: '', starts_at: local(new Date()), ends_at: local(new Date(Date.now() + 3600_000)), resource_ids: preset ?? [] as string[], tags: '', include_dependents: true });
  const [q, setQ] = useState('');
  const options = useMemo(() => (res.data ?? []).filter((r) => !q || r.label.toLowerCase().includes(q.toLowerCase())).slice(0, 60), [res.data, q]);
  const save = useMutation({
    mutationFn: () => post('/maintenance', { name: m.name, reason: m.reason || null, starts_at: new Date(m.starts_at).toISOString(), ends_at: new Date(m.ends_at).toISOString(),
      resource_ids: m.resource_ids, match_tags: m.tags.split(',').map((t) => t.trim()).filter(Boolean), include_dependents: m.include_dependents }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['maintenance'] }); toast('Wartungsfenster angelegt'); onClose(); },
    onError: (e: Error) => toast(e.message, true),
  });
  return (
    <Modal title="Wartungsfenster planen" wide onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>Speichern</button></>}>
      <div className="form-grid">
        <Field label="Name"><input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} /></Field>
        <Field label="Grund"><input value={m.reason} onChange={(e) => setM({ ...m, reason: e.target.value })} placeholder="Firmware-Update NAS" /></Field>
        <Field label="Beginn"><input type="datetime-local" value={m.starts_at} onChange={(e) => setM({ ...m, starts_at: e.target.value })} /></Field>
        <Field label="Ende"><div className="row"><input type="datetime-local" value={m.ends_at} onChange={(e) => setM({ ...m, ends_at: e.target.value })} style={{ flex: 1 }} />
          {[1, 4, 24].map((h) => <button key={h} className="sm" onClick={() => setM({ ...m, ends_at: local(new Date(new Date(m.starts_at).getTime() + h * 3600_000)) })}>{h} h</button>)}</div></Field>
        <Field label="Tags (optional)" hint="Alle Ressourcen mit einem dieser Tags"><input value={m.tags} onChange={(e) => setM({ ...m, tags: e.target.value })} /></Field>
        <label className="check" style={{ marginTop: 18 }}><input type="checkbox" checked={m.include_dependents} onChange={(e) => setM({ ...m, include_dependents: e.target.checked })} />abhängige Komponenten einschließen</label>
      </div>
      <Field label={`Ressourcen (${m.resource_ids.length} gewählt)`}><input placeholder="Ressource suchen" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>{options.map((r) => (
        <label key={r.id} className="check" style={{ fontSize: 12.5 }}><input type="checkbox" checked={m.resource_ids.includes(r.id)} onChange={(e) => setM({ ...m, resource_ids: e.target.checked ? [...m.resource_ids, r.id] : m.resource_ids.filter((x) => x !== r.id) })} />{r.label}</label>))}</div>
    </Modal>
  );
}
