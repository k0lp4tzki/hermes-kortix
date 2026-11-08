import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { fmt, ago } from '../lib/format';
import { Empty } from './ui';
import { Chart } from './Chart';
import { useCheckTypes } from './CheckEditor';

const RANGES: Array<[string, number]> = [['1 h', 3600], ['6 h', 6 * 3600], ['24 h', 86400], ['7 T', 7 * 86400], ['30 T', 30 * 86400], ['1 J', 365 * 86400]];

interface Group { key: string; title: string; unit: string; metrics: string[]; labels: Record<string, string> }

/** Groups "fs_used_percent:/" and "fs_used_percent:/data" into one chart. */
function groupSeries(series: any[], catalog: Map<string, { label: string; order: number }>): Group[] {
  const g = new Map<string, Group>();
  for (const s of series) {
    if (['running', 'is_replica', 'active', 'status_code'].includes(s.metric) || s.metric.startsWith('fs_size_bytes')) continue;
    const [base, inst] = s.metric.split(':');
    const key = `${s.check_id}:${base}`;
    const cat = catalog.get(inst !== undefined ? `${base}:*` : base) ?? catalog.get(base);
    if (!g.has(key)) g.set(key, { key, title: cat?.label ?? (inst ? s.label?.replace(` ${inst}`, '') : s.label) ?? base, unit: s.unit, metrics: [], labels: {}, order: cat?.order ?? 999 } as Group);
    const grp = g.get(key)!;
    grp.metrics.push(s.metric);
    grp.labels[s.metric] = inst ?? s.label ?? base;
  }
  return [...g.values()].sort((a, b) => (a as any).order - (b as any).order);
}

export function ResourceMetrics({ resource }: { resource: any }) {
  const [range, setRange] = useState(3600);
  const series = useQuery({ queryKey: ['metrics', resource.id, 'series'], queryFn: () => get<any[]>(`/resources/${resource.id}/series`), refetchInterval: 30000 });
  const types = useCheckTypes();
  const catalog = useMemo(() => {
    const m = new Map<string, { label: string; order: number }>();
    for (const t of types.data?.types ?? []) t.metrics.forEach((x: any, i: number) => m.set(x.name, { label: x.label, order: i }));
    return m;
  }, [types.data]);
  const groups = useMemo(() => groupSeries(series.data ?? [], catalog), [series.data, catalog]);
  if (series.isLoading) return <Empty>Lade Messreihen…</Empty>;
  if (!groups.length) return <div className="panel"><Empty>Noch keine Messwerte. Messreihen entstehen, sobald aktive Checks laufen.</Empty></div>;
  const byCheck = new Map<string, { name: string; groups: Group[] }>();
  for (const g of groups) {
    const s = series.data!.find((x) => x.metric === g.metrics[0]);
    const k = s?.check_id ?? 'x';
    if (!byCheck.has(k)) byCheck.set(k, { name: s?.check_name ?? 'Check', groups: [] });
    byCheck.get(k)!.groups.push(g);
  }
  return (
    <div className="stack">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <div className="tabs">{RANGES.map(([l, s]) => <button key={s} className={`tab ${range === s ? 'active' : ''}`} onClick={() => setRange(s)}>{l}</button>)}</div>
        <span className="sub">Auflösung: {range <= 6 * 3600 ? 'Rohdaten' : range <= 14 * 86400 ? '5-Minuten-Mittel' : 'Stundenmittel'} (Min/Max in Aggregaten erhalten)</span>
      </div>
      {[...byCheck.values()].map((c) => (
        <div key={c.name}>
          <h3>{c.name}</h3>
          <div className="grid2">{c.groups.map((g) => <MetricChart key={g.key} resourceId={resource.id} group={g} range={range} series={series.data!} />)}</div>
        </div>
      ))}
    </div>
  );
}

function MetricChart({ resourceId, group, range, series }: { resourceId: string; group: Group; range: number; series: any[] }) {
  const data = useQuery({
    queryKey: ['metrics', resourceId, group.metrics.join(','), range],
    queryFn: () => get(`/metrics?resource_id=${resourceId}&metric=${encodeURIComponent(group.metrics.join(','))}&from=${new Date(Date.now() - range * 1000).toISOString()}`),
    refetchInterval: range <= 6 * 3600 ? 30000 : 300000,
  });
  const s = group.metrics.map((mm) => ({ label: group.labels[mm], t: data.data?.series[mm]?.t ?? [], v: data.data?.series[mm]?.v ?? [] }));
  const latest = group.metrics.length === 1 ? series.find((x) => x.metric === group.metrics[0]) : null;
  return (
    <div className="panel" style={{ padding: '10px 12px' }}>
      <div className="chart-title">{group.title}{latest && <span className="cur" title={`gemessen ${ago(latest.last_time)}`}>{fmt(latest.last_value, group.unit)}</span>}</div>
      {data.isLoading ? <div style={{ height: 150 }} /> : s.every((x) => x.t.length === 0) ? <div className="empty" style={{ height: 150 }}>Keine Daten im Zeitraum</div> : <Chart series={s} unit={group.unit} height={150} />}
    </div>
  );
}
