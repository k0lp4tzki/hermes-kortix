import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago, ts } from '../lib/format';
import { Badge, Empty, Field, Icon, Modal, useToast } from '../components/ui';

export default function Settings() {
  const { can } = useAuth();
  const tabs = [
    ...(can('admin') ? [['users', 'Benutzer']] : []),
    ...(can('operator') ? [['secrets', 'Zugangsdaten']] : []),
    ['account', 'Mein Konto'],
    ...(can('admin') ? [['audit', 'Audit-Log']] : []),
  ] as [string, string][];
  const [tab, setTab] = useState(tabs[0][0]);
  return (
    <div className="page">
      <div className="page-head"><h1>Einstellungen</h1></div>
      <div className="toolbar"><div className="tabs">{tabs.map(([k, l]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div></div>
      {tab === 'users' && <Users />}
      {tab === 'secrets' && <Secrets />}
      {tab === 'account' && <Account />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function Users() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get('/users') });
  const [edit, setEdit] = useState<any | null>(null);
  const save = useMutation({
    mutationFn: (u: any) => (u.id ? patch(`/users/${u.id}`, { display_name: u.display_name, role: u.role, disabled: u.disabled, password: u.password || undefined }) : post('/users', u)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setEdit(null); toast('Benutzer gespeichert'); },
    onError: (e: Error) => toast(e.message, true),
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/users/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }), onError: (e: Error) => toast(e.message, true) });
  return (
    <div className="panel flush">
      <div className="panel-head" style={{ padding: '12px 14px 0' }}><h2>Benutzer</h2><div className="actions"><button className="primary" onClick={() => setEdit({ username: '', password: '', role: 'viewer' })}><Icon name="plus" />Benutzer anlegen</button></div></div>
      <table className="t">
        <thead><tr><th>Benutzer</th><th>Name</th><th>Rolle</th><th>Status</th><th>Letzte Anmeldung</th><th /></tr></thead>
        <tbody>
          {(users.data ?? []).map((u: any) => (
            <tr key={u.id}>
              <td className="mono">{u.username}</td><td>{u.display_name ?? '–'}</td><td><Badge kind="info">{u.role}</Badge></td>
              <td>{u.disabled ? <Badge kind="critical">deaktiviert</Badge> : <Badge kind="ok">aktiv</Badge>}</td>
              <td className="dim">{u.last_login_at ? ago(u.last_login_at) : 'nie'}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="sm" onClick={() => setEdit({ ...u, password: '' })}>Bearbeiten</button>{' '}
                {u.id !== me?.id && <button className="sm danger" onClick={() => confirm(`Benutzer ${u.username} löschen?`) && remove.mutate(u.id)}>Löschen</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal title={edit.id ? `Benutzer ${edit.username}` : 'Benutzer anlegen'} onClose={() => setEdit(null)}
          footer={<><button onClick={() => setEdit(null)}>Abbrechen</button><button className="primary" disabled={save.isPending} onClick={() => save.mutate(edit)}>Speichern</button></>}>
          <div className="form-grid">
            <Field label="Benutzername"><input value={edit.username} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></Field>
            <Field label="Anzeigename"><input value={edit.display_name ?? ''} onChange={(e) => setEdit({ ...edit, display_name: e.target.value })} /></Field>
            <Field label="Rolle" hint="viewer: nur lesen · operator: konfigurieren · admin: zusätzlich Benutzer">
              <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}><option>viewer</option><option>operator</option><option>admin</option></select>
            </Field>
            <Field label={edit.id ? 'Neues Passwort (optional)' : 'Passwort'} hint="mindestens 8 Zeichen"><input type="password" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            {edit.id && <label className="check"><input type="checkbox" checked={!!edit.disabled} onChange={(e) => setEdit({ ...edit, disabled: e.target.checked })} />Konto deaktiviert</label>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Secrets() {
  const qc = useQueryClient();
  const toast = useToast();
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: () => get('/secrets') });
  const [edit, setEdit] = useState<any | null>(null);
  const save = useMutation({
    mutationFn: (s: any) => {
      const body = { name: s.name, description: s.description || null, kind: s.kind, value: s.value || undefined, expires_at: s.expires_at ? new Date(s.expires_at).toISOString() : null };
      return s.id ? put(`/secrets/${s.id}`, body) : post('/secrets', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['secrets'] }); setEdit(null); toast('Zugangsdaten gespeichert (verschlüsselt)'); },
    onError: (e: Error) => toast(e.message, true),
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/secrets/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['secrets'] }), onError: (e: Error) => toast(e.message, true) });
  return (
    <div className="panel flush">
      <div className="panel-head" style={{ padding: '12px 14px 0' }}>
        <h2>Zugangsdaten</h2><span className="sub">AES-256-GCM verschlüsselt gespeichert, Werte werden nie angezeigt. Verwendung in HTTP-, Datenbank- und Webhook-Konfiguration.</span>
        <div className="actions"><button className="primary" onClick={() => setEdit({ name: '', kind: 'password', value: '' })}><Icon name="plus" />Zugangsdaten anlegen</button></div>
      </div>
      {secrets.data?.length === 0 ? <Empty>Noch keine Zugangsdaten gespeichert.</Empty> : (
        <table className="t">
          <thead><tr><th>Name</th><th>Art</th><th>Beschreibung</th><th>Verwendet von</th><th>Ablauf</th><th>Geändert</th><th /></tr></thead>
          <tbody>{(secrets.data ?? []).map((s: any) => (
            <tr key={s.id}>
              <td className="mono">{s.name}</td><td><Badge>{s.kind}</Badge></td><td className="dim">{s.description ?? '–'}</td>
              <td className="num">{s.used_by_checks} Checks</td>
              <td>{s.expires_at ? <span className={new Date(s.expires_at).getTime() < Date.now() + 14 * 864e5 ? 'err' : ''}>{ts(s.expires_at)}</span> : <span className="dim">–</span>}</td>
              <td className="dim">{ago(s.updated_at)}</td>
              <td style={{ textAlign: 'right' }}><button className="sm" onClick={() => setEdit({ ...s, value: '', expires_at: s.expires_at?.slice(0, 16) ?? '' })}>Bearbeiten</button>{' '}
                <button className="sm danger" onClick={() => confirm(`Zugangsdaten ${s.name} löschen?`) && remove.mutate(s.id)}>Löschen</button></td>
            </tr>))}
          </tbody>
        </table>
      )}
      {edit && (
        <Modal title={edit.id ? `Zugangsdaten ${edit.name}` : 'Zugangsdaten anlegen'} onClose={() => setEdit(null)}
          footer={<><button onClick={() => setEdit(null)}>Abbrechen</button><button className="primary" onClick={() => save.mutate(edit)} disabled={save.isPending}>Speichern</button></>}>
          <div className="form-grid">
            <Field label="Name"><input value={edit.name} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="z. B. grafana-admin" /></Field>
            <Field label="Art"><select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
              <option value="password">Passwort</option><option value="token">Token (Bearer)</option><option value="basic_auth">Basic Auth (user:passwort)</option><option value="connection_string">Verbindungs-URL</option><option value="generic">Allgemein</option></select></Field>
            <Field className="span2" label={edit.id ? 'Neuer Wert (leer lassen = unverändert)' : 'Wert'}><input type="password" autoComplete="new-password" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></Field>
            <Field className="span2" label="Beschreibung"><input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <Field label="Ablaufdatum (optional)" hint="Wird als Ablauf wichtiger Zugangsdaten überwacht"><input type="datetime-local" value={edit.expires_at ?? ''} onChange={(e) => setEdit({ ...edit, expires_at: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Account() {
  const toast = useToast();
  const { user } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const change = useMutation({ mutationFn: () => post('/auth/password', { current: cur, next }), onSuccess: () => { toast('Passwort geändert'); setCur(''); setNext(''); }, onError: (e: Error) => toast(e.message, true) });
  return (
    <div className="panel" style={{ maxWidth: 520 }}>
      <h2>Mein Konto</h2>
      <dl className="kv"><dt>Benutzer</dt><dd className="mono">{user?.username}</dd><dt>Rolle</dt><dd>{user?.role}</dd></dl>
      <div className="stack" style={{ marginTop: 16 }}>
        <Field label="Aktuelles Passwort"><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="Neues Passwort" hint="mindestens 8 Zeichen"><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <div><button className="primary" disabled={!cur || next.length < 8} onClick={() => change.mutate()}>Passwort ändern</button></div>
      </div>
    </div>
  );
}

function Audit() {
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => get('/audit') });
  return (
    <div className="panel flush">
      <table className="t">
        <thead><tr><th>Zeit</th><th>Benutzer</th><th>Aktion</th><th>Ziel</th><th>Details</th></tr></thead>
        <tbody>{(audit.data ?? []).map((a: any) => (
          <tr key={a.id}><td className="dim mono">{ts(a.time)}</td><td>{a.username ?? '–'}</td><td className="mono">{a.action}</td><td>{a.target ?? '–'}</td>
            <td className="mono dim" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{JSON.stringify(a.details)}</td></tr>))}
        </tbody>
      </table>
    </div>
  );
}
