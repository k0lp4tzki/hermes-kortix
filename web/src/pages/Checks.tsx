import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { ago, dur, fmt } from '../lib/format';
import { STATUS_RANK } from '../lib/meta';
import { Badge, Empty, Icon, StatusBadge } from '../components/ui';
import { CheckEditor, useCheckTypes } from '../components/CheckEditor';

export default function Checks() {
  const checks = useQuery({ queryKey: ['checks', 'all'], queryFn: () => get<any[]>('/checks'), refetchInterval: 10000 });
  const types = useCheckTypes();
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [type, setType] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const list = useMemo(() => (checks.data ?? [])
    .filter((c) => (!state || (state === 'disabled' ? !c.enabled : c.enabled && c.state === state)) && (!type || c.type === type)
      && (!search || `${c.name} ${c.resource_name} ${c.last_message ?? ''}`.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (STATUS_RANK[b.state] ?? 0) - (STATUS_RANK[a.state] ?? 0) || a.resource_name.localeCompare(b.resource_name)), [checks.data, search, state, type]);
  const count = (s: string) => (checks.data ?? []).filter((c) => c.enabled && c.state === s).length;
  return (
    <div className="page">
      <div className="page-head"><h1>Checks & Schwellwerte</h1><span className="sub">{checks.data?.length ?? 0} Checks · {count('critical')} critical · {count('warning')} warning · {count('unknown')} unknown</span></div>
      <div className="toolbar">
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Zustand"><option value="">Zustand: alle</option>{['critical', 'warning', 'unknown', 'ok', 'pending'].map((s) => <option key={s} value={s}>{s}</option>)}<option value="disabled">deaktiviert</option></select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Typ"><option value="">Typ: alle</option>{(types.data?.types ?? []).map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select>
        <div className="spacer" />
        <div className="search"><Icon name="search" /><input placeholder="Check, Ressource, Meldung suchen" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>
      <div className="panel flush table-wrap">
        {checks.isLoading ? <Empty>Lade…</Empty> : list.length === 0 ? <Empty>Keine Checks gefunden. Checks legst du in der Detailansicht einer Ressource an.</Empty> : (
          <table className="t">
            <thead><tr><th>Zustand</th><th>Ressource</th><th>Check</th><th>Ergebnis</th><th>Schwellwerte</th><th>Intervall</th><th>Letzter Lauf</th><th>Dauer</th><th /></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.id} style={{ opacity: c.enabled && c.resource_monitoring ? 1 : 0.5 }}>
                <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={c.enabled ? c.state : 'unmonitored'} label={c.enabled ? undefined : 'aus'} />{c.flapping && <> <Badge kind="warning">flattert</Badge></>}</td>
                <td><Link to={`/resources/${c.resource_id}`}>{c.resource_name}</Link></td>
                <td>{c.name}<div className="dim" style={{ fontSize: 11 }}>{c.type}</div></td>
                <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.last_message}>{c.last_message ?? <span className="dim">–</span>}</td>
                <td className="mono dim" style={{ fontSize: 11 }}>{(c.thresholds ?? []).slice(0, 3).map((t: any) => `${t.metric} ${t.op} ${t.warning ?? '–'}/${t.critical ?? '–'}`).join(', ')}{c.thresholds?.length > 3 ? ' …' : ''}</td>
                <td className="num">{dur(c.interval_s)}</td>
                <td className="dim">{c.last_run ? ago(c.last_run) : '–'}</td>
                <td className="num">{c.last_duration_ms != null ? fmt(c.last_duration_ms, 'ms') : '–'}</td>
                <td><button className="sm" onClick={() => setEdit(c)}>Bearbeiten</button></td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {edit && <CheckEditor resource={{ id: edit.resource_id, name: edit.resource_name, connection: {} }} check={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
