import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import { fmt } from '../lib/format';

const COLORS = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#a3e635'];

export interface Series { label: string; t: number[]; v: number[] }

/** Thin uPlot wrapper: aligned timestamps, unit-aware axis, dark theme, values on hover. */
export function Chart({ series, unit, height = 160, yMin }: { series: Series[]; unit?: string | null; height?: number; yMin?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const ts = Array.from(new Set(series.flatMap((s) => s.t))).sort((a, b) => a - b);
    const idx = series.map((s) => new Map(s.t.map((t, i) => [t, s.v[i]])));
    const data: uPlot.AlignedData = [ts, ...idx.map((m) => ts.map((t) => (m.has(t) ? m.get(t)! : null)))] as any;
    const opts: uPlot.Options = {
      width: el.current.clientWidth || 400,
      height,
      cursor: { points: { size: 6 } },
      legend: { show: series.length > 1 },
      scales: { x: { time: true }, y: { range: (_u, min, max) => [yMin ?? (unit === 'percent' || min >= 0 ? 0 : min), unit === 'percent' ? Math.max(100, max) : max === min ? max + 1 : max * 1.1] } },
      axes: [
        { stroke: '#66778a', grid: { stroke: '#16202a', width: 1 }, ticks: { stroke: '#1c2733' }, font: '11px ui-monospace, monospace',
          values: (_u, vals) => { const span = (vals[vals.length - 1] ?? 0) - (vals[0] ?? 0); return vals.map((v) => { const d = new Date(v * 1000);
            return span > 2 * 86400 ? d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }); } },
        { stroke: '#66778a', grid: { stroke: '#16202a', width: 1 }, ticks: { stroke: '#1c2733' }, font: '11px ui-monospace, monospace', size: 84, values: (_u, vals) => vals.map((v) => fmt(v, unit)) },
      ],
      series: [{ value: (_u, v) => (v ? new Date(v * 1000).toLocaleString('de-DE') : '') }, ...series.map((s, i) => ({
        label: s.label, stroke: COLORS[i % COLORS.length], width: 1.5, fill: series.length === 1 ? COLORS[i % COLORS.length] + '18' : undefined,
        spanGaps: false, points: { show: false }, value: (_u: uPlot, v: number | null) => (v === null ? '–' : fmt(v, unit)),
      }))],
    };
    plot.current?.destroy();
    plot.current = new uPlot(opts, data, el.current);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: el.current!.clientWidth, height }));
    ro.observe(el.current);
    return () => { ro.disconnect(); plot.current?.destroy(); plot.current = null; };
  }, [series, unit, height, yMin]);
  return <div ref={el} className="chart-box" />;
}

export function Sparkline({ values, color = '#38bdf8', width = 120, height = 28 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - ((v - min) / span) * (height - 4)}`).join(' ');
  return <svg width={width} height={height}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" /></svg>;
}
