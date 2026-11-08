import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../lib/api';
import { ago, ts } from '../lib/format';
import { useAuth } from '../lib/auth';
import { CRIT_LABEL, CRITS, KIND_LABEL } from '../lib/meta';
import { Badge, Empty, Field, Icon, Modal, useToast } from '../components/ui';

export default function Notifications() {
  const [tab, setTab] = useState('channels');
  return (
    <div className="page">
      <div className="page-head"><h1>Benachrichtigungen</h1><span className="sub">Kanäle (generischer JSON-Webhook) und Regeln, wer worüber benachrichtigt wird.</span></div>
      <div className="toolbar"><div className="tabs">{[['channels', 'Kanäle'], ['rules', 'Routing-Regeln'], ['log', 'Protokoll']].map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div></div>
      {tab === 'channels' && <Channels />}
      {tab === 'rules' && <Rules />}
      {tab === 'log' && <Log />}
    </div>
  );
}

function Channels() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const ch = useQuery({ queryKey: ['notifications', 'channels'], queryFn: () => get<any[]>('/notifications/channels') });
  const [edit, setEdit] = useState<any | null>(null);
  const test = useMutation({ mutationFn: (id: string) => post(`/notifications/channels/${id}/test`), onSuccess: (r: any) => { toast(r.ok ? `Test gesendet (HTTP ${r.status}, ${Math.round(r.durationMs)} ms)` : `Test fehlgeschlagen: ${r.error}`, !r.ok); qc.invalidateQueries({ queryKey: ['notifications'] }); } });
  const remove = useMutation({ mutationFn: (id: string) => del(`/notifications/channels/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <>
      <div className="toolbar"><div className="spacer" />{can('operator') && <button className="primary" onClick={() => setEdit({ name: '', enabled: true, config: { url: '', method: 'POST', headers: {}, timeout_ms: 10000 } })}><Icon name="plus" />Webhook anlegen</button>}</div>
      <div className="panel flush">
        {!ch.data?.length ? <Empty>Noch kein Kanal. Lege einen Webhook an (z. B. ntfy, Gotify, Home Assistant, n8n, Slack-/Discord-Bridge oder eigenes Skript).</Empty> : (
          <table className="t">
            <thead><tr><th>Name</th><th>Ziel</th><th>Signatur</th><th>Letzter Versand</th><th>7 Tage</th><th /></tr></thead>
            <tbody>{ch.data.map((c) => (
              <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                <td>{c.name}{!c.enabled && <> <Badge>deaktiviert</Badge></>}</td>
                <td className="mono dim" style={{ fontSize: 12 }}>{c.config.method ?? 'POST'} {c.config.url}</td>
                <td>{c.config.hmac_secret_id ? <Badge kind="ok">HMAC-SHA256</Badge> : <span className="dim">–</span>}</td>
                <td>{c.last_sent_at ? <>{c.last_status === 'ok' ? <Badge kind="ok">ok</Badge> : <span className="err" style={{ fontSize: 12 }}>{c.last_status}</span>} <span className="dim">{ago(c.last_sent_at)}</span></> : <span className="dim">noch nie</span>}</td>
                <td className="num">{c.sent_7d}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{can('operator') && <><button className="sm" onClick={() => test.mutate(c.id)} disabled={test.isPending}>Test senden</button> <button className="sm" onClick={() => setEdit(c)}>Bearbeiten</button> <button className="sm danger" onClick={() => confirm('Kanal löschen?') && remove.mutate(c.id)}>Löschen</button></>}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      <details className="callout" style={{ marginTop: 14 }}><summary style={{ cursor: 'pointer' }}>Format der Webhook-Nachricht</summary>
        <pre className="mono" style={{ fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{`POST <url>  Content-Type: application/json  [X-Hermes-Signature: sha256=<hmac>]
{ "version": 1, "source": "hermes", "event": "critical|warning|recovery|reminder|test",
  "dedup_key": "hermes:incident:<id>", "timestamp": "...", "message": "[CRITICAL] …",
  "incident": { "id", "status", "severity", "peak_severity", "title", "opened_at", "resolved_at", "duration_s", "occurrences_7d", "flapping", "acknowledged_by", "url" },
  "resource": { "id", "name", "kind", "host", "criticality", "environment", "group", "tags", "status" },
  "root_cause": { "id", "name" }, "impacted": [ … ], "suppressed_symptoms": [ … ], "checks": [ { "name", "type", "state", "message" } ] }`}</pre>
      </details>
      {edit && <ChannelDialog channel={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function ChannelDialog({ channel, onClose }: { channel: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: () => get<any[]>('/secrets').catch(() => []) });
  const [c, setC] = useState<any>(channel);
  const [headers, setHeaders] = useState(Object.entries(channel.config.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
  const save = useMutation({
    mutationFn: () => {
      const h: Record<string, string> = {};
      for (const line of headers.split('\n')) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      const body = { name: c.name, type: 'webhook', enabled: c.enabled, config: { url: c.config.url, method: c.config.method ?? 'POST', headers: h, hmac_secret_id: c.config.hmac_secret_id || null, auth_secret_id: c.config.auth_secret_id || null, timeout_ms: Number(c.config.timeout_ms ?? 10000) } };
      return c.id ? put(`/notifications/channels/${c.id}`, body) : post('/notifications/channels', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notifications'] }); toast('Kanal gespeichert'); onClose(); },
    onError: (e: Error) => toast(e.message, true),
  });
  const cfg = (k: string, v: any) => setC({ ...c, config: { ...c.config, [k]: v } });
  return (
    <Modal title={c.id ? 'Webhook bearbeiten' : 'Webhook anlegen'} onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!c.name || !c.config.url} onClick={() => save.mutate()}>Speichern</button></>}>
      <div className="form-grid">
        <Field label="Name"><input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="ntfy Bereitschaft" /></Field>
        <Field label="Methode"><select value={c.config.method ?? 'POST'} onChange={(e) => cfg('method', e.target.value)}><option>POST</option><option>PUT</option></select></Field>
        <Field className="span2" label="URL"><input value={c.config.url} onChange={(e) => cfg('url', e.target.value)} placeholder="https://ntfy.example/hermes" /></Field>
        <Field className="span2" label="Zusätzliche Header" hint="Eine Zeile pro Header: Name: Wert"><textarea rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} /></Field>
        <Field label="HMAC-Signatur mit" hint="Header X-Hermes-Signature"><select value={c.config.hmac_secret_id ?? ''} onChange={(e) => cfg('hmac_secret_id', e.target.value || null)}><option value="">keine</option>{(secrets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Bearer-Token aus"><select value={c.config.auth_secret_id ?? ''} onChange={(e) => cfg('auth_secret_id', e.target.value || null)}><option value="">keins</option>{(secrets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <label className="check"><input type="checkbox" checked={c.enabled} onChange={(e) => setC({ ...c, enabled: e.target.checked })} />Kanal aktiv</label>
      </div>
    </Modal>
  );
}

function Rules() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const rules = useQuery({ queryKey: ['notifications', 'rules'], queryFn: () => get<any[]>('/notifications/rules') });
  const ch = useQuery({ queryKey: ['notifications', 'channels'], queryFn: () => get<any[]>('/notifications/channels') });
  const [edit, setEdit] = useState<any | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => del(`/notifications/rules/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const chName = (id: string) => ch.data?.find((c) => c.id === id)?.name ?? '?';
  const describe = (m: any) => [m.min_severity && `ab ${m.min_severity}`, m.kinds?.length && `Typ: ${m.kinds.map((k: string) => KIND_LABEL[k] ?? k).join(', ')}`, m.tags?.length && `Tags: ${m.tags.join(', ')}`,
    m.environments?.length && `Umgebung: ${m.environments.join(', ')}`, m.criticalities?.length && `Kritikalität: ${m.criticalities.map((c: string) => CRIT_LABEL[c]).join(', ')}`, m.groups?.length && `Gruppe: ${m.groups.join(', ')}`].filter(Boolean).join(' · ') || 'alle Störungen';
  return (
    <>
      <div className="toolbar"><span className="sub">Regeln werden nach Priorität geprüft; „Stopp“ beendet die Prüfung. Folgefehler, flatternde Zustände und Wartungsfenster werden nicht gemeldet.</span><div className="spacer" />
        {can('operator') && <button className="primary" disabled={!ch.data?.length} onClick={() => setEdit({ name: '', priority: 100, enabled: true, match: {}, channel_ids: [], on_warning: true, on_critical: true, on_recovery: true, repeat_interval_s: 0, stop: false })}><Icon name="plus" />Regel anlegen</button>}</div>
      <div className="panel flush">
        {!rules.data?.length ? <Empty>{ch.data?.length ? 'Keine Regeln – es werden keine Benachrichtigungen versendet.' : 'Lege zuerst einen Kanal an.'}</Empty> : (
          <table className="t">
            <thead><tr><th>Prio</th><th>Name</th><th>Bedingung</th><th>Ereignisse</th><th>Kanäle</th><th>Erinnerung</th><th /></tr></thead>
            <tbody>{rules.data.map((r) => (
              <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.5 }}>
                <td className="num">{r.priority}</td><td>{r.name}{r.stop && <> <Badge>Stopp</Badge></>}</td><td className="dim">{describe(r.match)}</td>
                <td>{[r.on_warning && 'Warning', r.on_critical && 'Critical', r.on_recovery && 'Recovery'].filter(Boolean).join(', ')}</td>
                <td>{r.channel_ids.map(chName).join(', ')}</td>
                <td className="dim">{r.repeat_interval_s ? `alle ${Math.round(r.repeat_interval_s / 60)} min` : '–'}</td>
                <td style={{ textAlign: 'right' }}>{can('operator') && <><button className="sm" onClick={() => setEdit(r)}>Bearbeiten</button> <button className="sm danger" onClick={() => remove.mutate(r.id)}>Löschen</button></>}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {edit && <RuleDialog rule={edit} channels={ch.data ?? []} onClose={() => setEdit(null)} />}
    </>
  );
}

function RuleDialog({ rule, channels, onClose }: { rule: any; channels: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [r, setR] = useState<any>(rule);
  const [txt, setTxt] = useState({ kinds: (rule.match.kinds ?? []).join(', '), tags: (rule.match.tags ?? []).join(', '), environments: (rule.match.environments ?? []).join(', '), groups: (rule.match.groups ?? []).join(', ') });
  const save = useMutation({
    mutationFn: () => {
      const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
      const match: any = {};
      if (r.match.min_severity) match.min_severity = r.match.min_severity;
      for (const k of ['kinds', 'tags', 'environments', 'groups'] as const) if (split(txt[k]).length) match[k] = split(txt[k]);
      if (r.match.criticalities?.length) match.criticalities = r.match.criticalities;
      const body = { ...r, match, priority: Number(r.priority), repeat_interval_s: Number(r.repeat_interval_s) };
      delete body.id; delete body.created_at;
      return r.id ? put(`/notifications/rules/${r.id}`, body) : post('/notifications/rules', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notifications'] }); toast('Regel gespeichert'); onClose(); },
    onError: (e: Error) => toast(e.message, true),
  });
  return (
    <Modal title={r.id ? 'Routing-Regel bearbeiten' : 'Routing-Regel anlegen'} wide onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!r.name || !r.channel_ids.length} onClick={() => save.mutate()}>Speichern</button></>}>
      <div className="form-grid">
        <Field label="Name"><input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Kritisches an Bereitschaft" /></Field>
        <Field label="Priorität"><input type="number" value={r.priority} onChange={(e) => setR({ ...r, priority: e.target.value })} /></Field>
        <Field label="Mindest-Schwere"><select value={r.match.min_severity ?? ''} onChange={(e) => setR({ ...r, match: { ...r.match, min_severity: e.target.value || undefined } })}><option value="">alle</option><option value="warning">Warning</option><option value="critical">nur Critical</option></select></Field>
        <Field label="Typen" hint="kommagetrennt, z. B. host, container, database"><input value={txt.kinds} onChange={(e) => setTxt({ ...txt, kinds: e.target.value })} /></Field>
        <Field label="Tags (einer davon)"><input value={txt.tags} onChange={(e) => setTxt({ ...txt, tags: e.target.value })} /></Field>
        <Field label="Umgebungen"><input value={txt.environments} onChange={(e) => setTxt({ ...txt, environments: e.target.value })} placeholder="prod" /></Field>
        <Field label="Gruppen"><input value={txt.groups} onChange={(e) => setTxt({ ...txt, groups: e.target.value })} /></Field>
        <Field label="Kritikalität"><div className="row">{CRITS.map((c) => <label key={c} className="check"><input type="checkbox" checked={(r.match.criticalities ?? []).includes(c)} onChange={(e) => setR({ ...r, match: { ...r.match, criticalities: e.target.checked ? [...(r.match.criticalities ?? []), c] : (r.match.criticalities ?? []).filter((x: string) => x !== c) } })} />{CRIT_LABEL[c]}</label>)}</div></Field>
        <Field className="span2" label="Kanäle"><div className="row" style={{ flexWrap: 'wrap' }}>{channels.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={r.channel_ids.includes(c.id)} onChange={(e) => setR({ ...r, channel_ids: e.target.checked ? [...r.channel_ids, c.id] : r.channel_ids.filter((x: string) => x !== c.id) })} />{c.name}</label>)}</div></Field>
        <Field className="span2" label="Melden bei"><div className="row">
          <label className="check"><input type="checkbox" checked={r.on_warning} onChange={(e) => setR({ ...r, on_warning: e.target.checked })} />Warning</label>
          <label className="check"><input type="checkbox" checked={r.on_critical} onChange={(e) => setR({ ...r, on_critical: e.target.checked })} />Critical</label>
          <label className="check"><input type="checkbox" checked={r.on_recovery} onChange={(e) => setR({ ...r, on_recovery: e.target.checked })} />Recovery</label></div></Field>
        <Field label="Erinnerung alle (Sekunden, 0 = nie)" hint="bis die Störung bestätigt oder behoben ist"><input type="number" value={r.repeat_interval_s} onChange={(e) => setR({ ...r, repeat_interval_s: e.target.value })} /></Field>
        <div className="stack" style={{ gap: 6, marginTop: 18 }}>
          <label className="check"><input type="checkbox" checked={r.stop} onChange={(e) => setR({ ...r, stop: e.target.checked })} />Stopp: danach keine weiteren Regeln prüfen</label>
          <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} />Regel aktiv</label></div>
      </div>
    </Modal>
  );
}

function Log() {
  const log = useQuery({ queryKey: ['notifications', 'log'], queryFn: () => get<any[]>('/notifications/log'), refetchInterval: 15000 });
  const [open, setOpen] = useState<number | null>(null);
  const detail = useQuery({ queryKey: ['notifications', 'log', open], queryFn: () => get(`/notifications/log/${open}`), enabled: open !== null });
  return (
    <div className="panel flush">
      {!log.data?.length ? <Empty>Noch keine Benachrichtigungen.</Empty> : (
        <table className="t">
          <thead><tr><th>Zeit</th><th>Ereignis</th><th>Status</th><th>Kanal</th><th>Regel</th><th>Störung</th><th>Antwort</th></tr></thead>
          <tbody>{log.data.map((n) => (
            <tr key={n.id} className="click" onClick={() => setOpen(n.id)}>
              <td className="mono dim" style={{ fontSize: 12 }}>{ts(n.time)}</td><td>{n.event}</td>
              <td><Badge kind={n.status === 'sent' ? 'ok' : n.status === 'failed' ? 'critical' : ''}>{n.status === 'sent' ? 'gesendet' : n.status === 'failed' ? 'fehlgeschlagen' : 'unterdrückt'}</Badge></td>
              <td>{n.channel_name ?? '–'}</td><td className="dim">{n.rule_name ?? '–'}</td>
              <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.incident_title ?? '–'}</td>
              <td className="dim" style={{ fontSize: 12 }}>{n.http_status ? `HTTP ${n.http_status}` : ''} {n.reason ?? ''} {n.duration_ms ? `${Math.round(n.duration_ms)} ms` : ''}</td>
            </tr>))}</tbody>
        </table>
      )}
      {open !== null && <Modal title="Gesendete Nachricht" wide onClose={() => setOpen(null)}><pre className="mono" style={{ fontSize: 11.5, maxHeight: 500, overflow: 'auto' }}>{JSON.stringify(detail.data?.payload, null, 2)}</pre></Modal>}
    </div>
  );
}
