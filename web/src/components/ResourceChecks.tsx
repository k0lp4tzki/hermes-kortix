import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../lib/api';
import { ago, dur, fmt, ts } from '../lib/format';
import { useAuth } from '../lib/auth';
import { Badge, Empty, Icon, StatusBadge, useToast } from './ui';
import { CheckEditor } from './CheckEditor';
import { Chart } from './Chart';

export function ResourceChecks({ resource }: { resource: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const checks = useQuery({ queryKey: ['checks', resource.id], queryFn: () => get<any[]>(`/checks?resource_id=${resource.id}`), refetchInterval: 10000 });
  const [edit, setEdit] = useState<any | null | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const run = useMutation({ mutationFn: (id: string) => post(`/checks/${id}/run`), onSuccess: () => toast('Check wird ausgeführt') });
  const toggle = useMutation({ mutationFn: (c: any) => put(`/checks/${c.id}`, { ...c, enabled: !c.enabled, secret_id: c.secret_id }), onSuccess: () => qc.invalidateQueries({ queryKey: ['checks'] }), onError: (e: Error) => toast(e.message, true) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/checks/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['checks'] }) });
  return (
    <div className="panel flush">
      <div className="panel-head" style={{ padding: '12px 14px 0' }}>
        <h2>Checks</h2>{!resource.monitoring_enabled && <Badge kind="warning">Überwachung der Ressource ist aus – Checks laufen nicht</Badge>}
        <div className="actions">{can('operator') && <button className="primary" onClick={() => setEdit(null)}><Icon name="plus" />Check hinzufügen</button>}</div>
      </div>
      {checks.data?.length === 0 ? <Empty>Keine Checks. Füge einen hinzu, um diese Ressource zu überwachen.</Empty> : (
        <table className="t">
          <thead><tr><th>Zustand</th><th>Check</th><th>Ergebnis</th><th>Intervall</th><th>Letzter Lauf</th><th>Dauer</th><th /></tr></thead>
          <tbody>{(checks.data ?? []).map((c) => [
            <tr key={c.id} className="click" onClick={() => setOpen(open === c.id ? null : c.id)} style={{ opacity: c.enabled ? 1 : 0.5 }}>
              <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={c.enabled ? c.state : 'unmonitored'} label={c.enabled ? undefined : 'deaktiviert'} />{c.flapping && <> <Badge kind="warning">flattert</Badge></>}
                {c.enabled && c.last_raw_state && c.last_raw_state !== c.state && c.state !== 'pending' && <div className="dim" style={{ fontSize: 11 }}>aktuell {c.last_raw_state}, {c.soft_count}× (unbestätigt)</div>}</td>
              <td><div style={{ fontWeight: 500 }}>{c.name}</div><div className="dim" style={{ fontSize: 11.5 }}>{c.type}{c.secret_name && ` · Zugangsdaten ${c.secret_name}`}{c.origin === 'auto' && ' · Standard-Check'}</div></td>
              <td style={{ maxWidth: 520 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.last_message}>{c.last_message ?? <span className="dim">noch nicht ausgeführt</span>}</div>
                {c.last_metrics?._unavailable && Object.keys(c.last_metrics._unavailable).length > 0 && <div className="na" style={{ fontSize: 11.5 }}>nicht verfügbar: {Object.entries(c.last_metrics._unavailable).map(([k, v]) => `${k} (${v})`).join(', ')}</div>}</td>
              <td className="num">{dur(c.interval_s)}</td>
              <td className="dim" title={ts(c.last_run)}>{c.last_run ? ago(c.last_run) : '–'}</td>
              <td className="num">{c.last_duration_ms != null ? fmt(c.last_duration_ms, 'ms') : '–'}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>{can('operator') && <>
                <button className="sm" onClick={() => run.mutate(c.id)} disabled={!c.enabled || !resource.monitoring_enabled} title="Jetzt ausführen"><Icon name="play" size={12} /></button>{' '}
                <button className="sm" onClick={() => setEdit(c)}>Bearbeiten</button>{' '}
                <button className="sm" onClick={() => toggle.mutate(c)}>{c.enabled ? 'Aus' : 'An'}</button>{' '}
                <button className="sm danger" onClick={() => confirm(`Check „${c.name}“ löschen?`) && remove.mutate(c.id)}><Icon name="trash" size={12} /></button></>}
              </td>
            </tr>,
            open === c.id ? <tr key={c.id + '-x'}><td colSpan={7} style={{ background: 'var(--bg-2)' }}><CheckDetail check={c} /></td></tr> : null,
          ])}</tbody>
        </table>
      )}
      {edit !== undefined && <CheckEditor resource={resource} check={edit ?? undefined} onClose={() => setEdit(undefined)} />}
    </div>
  );
}

function CheckDetail({ check }: { check: any }) {
  const results = useQuery({ queryKey: ['checks', check.id, 'results'], queryFn: () => get<any[]>(`/checks/${check.id}/results?limit=60`) });
  const metrics = Object.entries(check.last_metrics ?? {}).filter(([k]) => !k.startsWith('_'));
  const durations = [...(results.data ?? [])].reverse();
  return (
    <div className="grid2" style={{ padding: '6px 0' }}>
      <div>
        <h3>Letzte Messwerte</h3>
        {metrics.length === 0 ? <span className="dim">keine</span> : <div className="mono" style={{ fontSize: 12, columns: 2 }}>{metrics.map(([k, v]) => <div key={k}>{k} = {typeof v === 'number' ? (Math.abs(v) > 1000 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, '')) : String(v)}</div>)}</div>}
        <h3 style={{ marginTop: 10 }}>Schwellwerte & Zustandslogik</h3>
        <div className="mono dim" style={{ fontSize: 12 }}>{(check.thresholds ?? []).map((t: any, i: number) => <div key={i}>{t.metric} {t.op} warn {t.warning ?? '–'} / crit {t.critical ?? '–'}</div>)}
          <div>bestätigt nach {check.fail_after}× schlecht{check.hold_s ? ` und ${check.hold_s}s` : ''}, Recovery nach {check.recover_after}× gut · Flap-Score {check.flap_score} %</div>
          <div>Zustand seit {ts(check.state_since)}</div></div>
      </div>
      <div>
        <h3>Laufzeit der letzten {durations.length} Ausführungen</h3>
        {durations.length > 1 && <Chart series={[{ label: 'Dauer', t: durations.map((r) => new Date(r.time).getTime() / 1000), v: durations.map((r) => r.duration_ms) }]} unit="ms" height={110} />}
        <div className="feed" style={{ maxHeight: 160, overflow: 'auto', marginTop: 6 }}>{(results.data ?? []).slice(0, 15).map((r) => (
          <div key={r.time} className="feed-item"><time>{new Date(r.time).toLocaleTimeString('de-DE')}</time><span className={`dot ${r.raw_state}`} style={{ marginTop: 4 }} /><span className="msg dim">{r.message}</span></div>))}</div>
      </div>
    </div>
  );
}
