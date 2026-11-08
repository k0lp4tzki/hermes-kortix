import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { ago, bytes, dur, fmt, ts } from '../lib/format';
import { Link } from 'react-router-dom';
import { Badge, StatusBadge } from '../components/ui';

export default function Platform() {
  const h = useQuery({ queryKey: ['platform'], queryFn: () => get('/platform/health'), refetchInterval: 10000 });
  const d = h.data;
  const stale = (age: number) => (age > 60 ? 'critical' : age > 25 ? 'warning' : 'ok');
  const workerBeat = d?.components?.find((c: any) => c.component === 'worker');
  const ov = useQuery({ queryKey: ['overview'], queryFn: () => get('/overview') });
  const pr = ov.data?.platformResource;
  return (
    <div className="page">
      <div className="page-head"><h1>Plattform-Zustand</h1><span className="sub">Selbstüberwachung von Hermes: Komponenten, Scheduler, Datenbank, Aufbewahrung</span>
        {pr && <div className="actions"><StatusBadge status={pr.status} /><Link className="btn" to={`/resources/${pr.id}`}>Verlauf & Schwellwerte der Selbstüberwachung</Link></div>}</div>
      {d && !workerBeat && <div className="callout crit" style={{ marginBottom: 12 }}>Kein Heartbeat des Workers – Checks und Discovery laufen nicht.</div>}
      {workerBeat && workerBeat.age_s > 60 && <div className="callout crit" style={{ marginBottom: 12 }}>Worker-Heartbeat seit {dur(workerBeat.age_s)} ausgeblieben – Checks laufen nicht.</div>}
      <div className="tiles" style={{ marginBottom: 12 }}>
        <div className="tile"><div className="l">DB-Latenz (API)</div><div className="v">{d ? fmt(d.dbLatencyMs, 'ms') : '–'}</div></div>
        <div className="tile"><div className="l">Aktive Checks</div><div className="v">{d?.scheduler?.active_checks ?? '–'}</div></div>
        <div className={`tile ${d?.scheduler?.overdue ? 'warning' : ''}`}><div className="l">Check-Rückstau</div><div className="v">{d?.scheduler?.overdue ?? '–'}</div><div className="s">überfällig &gt; 10 s</div></div>
        <div className={`tile ${(d?.scheduler?.max_lag_s ?? 0) > 30 ? 'warning' : ''}`}><div className="l">Scheduler-Verzug</div><div className="v">{d?.scheduler ? fmt(d.scheduler.max_lag_s * 1000, 'ms') : '–'}</div></div>
        <div className="tile"><div className="l">Ergebnisse (5 min)</div><div className="v">{d?.throughput?.results_5m ?? '–'}</div><div className="s">Ø {d?.throughput ? fmt(d.throughput.avg_duration_ms, 'ms') : '–'}</div></div>
        <div className="tile"><div className="l">DB-Größe</div><div className="v">{bytes(d?.db?.size_bytes)}</div></div>
        <div className="tile"><div className="l">Live-Clients</div><div className="v">{d?.sseClients ?? '–'}</div></div>
      </div>
      <div className="grid2">
        <div className="panel flush">
          <div className="panel-head" style={{ padding: '12px 14px 0' }}><h2>Komponenten</h2></div>
          <table className="t"><thead><tr><th>Komponente</th><th>Status</th><th>Letzter Heartbeat</th><th>Läuft seit</th><th>Details</th></tr></thead>
            <tbody>{(d?.components ?? []).map((c: any) => (
              <tr key={c.component}><td className="mono">{c.component}</td><td><StatusBadge status={stale(c.age_s)} /></td><td className="dim">{ago(c.last_beat)}</td><td className="dim">{ago(c.started_at)}</td>
                <td className="mono dim" style={{ fontSize: 11 }}>{Object.entries(c.info ?? {}).filter(([k]) => k !== 'pid').map(([k, v]) => `${k}=${k === 'rss' ? bytes(v as number) : typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ')}</td></tr>))}
            </tbody></table>
        </div>
        <div className="panel">
          <h2>Datenbank</h2>
          <dl className="kv">
            <dt>Version</dt><dd className="mono" style={{ fontSize: 11 }}>{d?.db?.pg_version?.split(' on ')[0]}</dd>
            <dt>TimescaleDB</dt><dd className="mono">{d?.db?.timescale_version ?? <span className="na">nicht verfügbar</span>}</dd>
            <dt>Verbindungen</dt><dd className="mono">{d?.db?.connections} / {d?.db?.max_connections}</dd>
            <dt>Größe</dt><dd className="mono">{bytes(d?.db?.size_bytes)}</dd>
          </dl>
          <h3 style={{ marginTop: 14 }}>Hypertables</h3>
          {(d?.hypertables ?? []).map((t: any) => <div key={t.name} className="row mono" style={{ fontSize: 12 }}><span>{t.name}</span><span className="dim" style={{ marginLeft: 'auto' }}>{bytes(t.size_bytes)}</span></div>)}
        </div>
      </div>
      <div className="panel flush" style={{ marginTop: 12 }}>
        <div className="panel-head" style={{ padding: '12px 14px 0' }}><h2>Hintergrund-Jobs (Aufbewahrung, Downsampling)</h2></div>
        <table className="t"><thead><tr><th>Job</th><th>Tabelle</th><th>Intervall</th><th>Letzter Lauf</th><th>Nächster Lauf</th><th>Fehler</th></tr></thead>
          <tbody>{(d?.jobs ?? []).map((j: any) => (
            <tr key={j.job_id}><td className="mono">{j.application_name}</td><td className="mono">{j.hypertable_name}</td><td className="mono dim">{j.schedule_interval}</td>
              <td>{j.last_run_status ? <Badge kind={j.last_run_status === 'Success' ? 'ok' : 'critical'}>{j.last_run_status}</Badge> : <span className="dim">noch nicht</span>} <span className="dim">{j.last_successful_finish ? ago(j.last_successful_finish) : ''}</span></td>
              <td className="dim">{ts(j.next_start)}</td><td className="num">{j.total_failures ?? 0}</td></tr>))}
          </tbody></table>
      </div>
    </div>
  );
}
