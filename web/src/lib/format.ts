export function ago(ts?: string | number | Date | null): string {
  if (!ts) return '–';
  const d = typeof ts === 'object' ? ts.getTime() : new Date(ts).getTime();
  const s = Math.round((Date.now() - d) / 1000);
  if (s < -5) return 'in ' + dur(-s);
  if (s < 5) return 'gerade eben';
  return 'vor ' + dur(s);
}

export function dur(s: number): string {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60 ? (s % 60) + 's' : ''}`.trim();
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function ts(t?: string | null): string {
  if (!t) return '–';
  return new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
}

export function time(t?: string | null): string {
  if (!t) return '–';
  return new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function bytes(n?: number | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Format a metric value using its unit. */
export function fmt(v: number | null | undefined, unit?: string | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  switch (unit) {
    case 'bytes': return bytes(v);
    case 'bytes/s': return bytes(v) + '/s';
    case 'percent': return `${v.toFixed(v < 10 ? 1 : 0)} %`;
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`;
    case 's': return dur(v);
    case 'days': return `${v.toFixed(1)} d`;
    case 'celsius': return `${v.toFixed(1)} °C`;
    case 'bool': return v ? 'ja' : 'nein';
    case 'count': return Number.isInteger(v) ? String(v) : v.toFixed(1);
    case '/s': return `${v.toFixed(v < 10 ? 2 : 0)}/s`;
    default: return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
}

export const STATUS_LABEL: Record<string, string> = {
  ok: 'OK', warning: 'Warning', critical: 'Critical', unknown: 'Unknown', pending: 'Ausstehend', unmonitored: 'Nicht überwacht',
};
