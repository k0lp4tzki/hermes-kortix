import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { time, ts } from '../lib/format';
import { Empty } from './ui';

const SEV_DOT: Record<string, string> = { ok: 'ok', warning: 'warning', critical: 'critical', unknown: 'unknown', info: 'pending' };

export function EventFeed({ resourceId, incidentId, limit = 50, showResource = true, compact }: { resourceId?: string; incidentId?: string; limit?: number; showResource?: boolean; compact?: boolean }) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (resourceId) qs.set('resource_id', resourceId);
  if (incidentId) qs.set('incident_id', incidentId);
  const ev = useQuery({ queryKey: ['events', resourceId ?? '', incidentId ?? '', limit], queryFn: () => get<any[]>(`/events?${qs}`), refetchInterval: 30000 });
  if (ev.isLoading) return <Empty>Lade Ereignisse…</Empty>;
  if (!ev.data?.length) return <Empty>Noch keine Ereignisse.</Empty>;
  const today = new Date().toDateString();
  return (
    <div className="feed">
      {ev.data.map((e) => (
        <div key={e.id} className="feed-item" title={`${ts(e.time)} · ${e.kind}${e.actor ? ' · ' + e.actor : ''}`}>
          <time>{new Date(e.time).toDateString() === today ? time(e.time) : new Date(e.time).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</time>
          <span className={`dot ${SEV_DOT[e.severity] ?? ''}`} style={{ marginTop: 4 }} />
          <span className="msg">
            {showResource && e.resource_id && <><Link to={`/resources/${e.resource_id}`} style={{ fontWeight: 500 }}>{e.resource_name}</Link>{' '}</>}
            <span style={{ color: compact ? 'var(--text-2)' : undefined }}>{e.message}</span>
            {!compact && e.actor && <span className="dim"> · {e.actor}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
