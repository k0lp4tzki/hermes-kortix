import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { ago } from '../lib/format';
import { useAuth } from '../lib/auth';
import { DEP_TYPES, KIND_LABEL } from '../lib/meta';
import { Badge, Empty, Icon, StatusBadge, useToast } from './ui';

export const CONF_LABEL: Record<string, string> = { sure: 'sicher', evidence: 'beobachtet', hint: 'Vermutung' };
export const CONF_KIND: Record<string, string> = { sure: 'ok', evidence: 'info', hint: '' };
export const SOURCE_LABEL: Record<string, string> = { vmware: 'VMware', connections: 'Verbindungen', routing: 'Routing/Traceroute', dns: 'DNS', identity: 'Identität', cleanup: 'Bereinigung' };
export const typeLabel = (t: string) => (t === 'same_as' ? 'ist dasselbe Gerät wie' : t === 'remove_edge' ? 'Abhängigkeit entfernen' : t === 'set_kind' ? 'Typ ändern' : DEP_TYPES[t] ?? t);
const ACCEPT_LABEL: Record<string, [string, string, string]> = {
  same_as: ['merge', 'Zusammenführen', 'Verschiedene Geräte'], remove_edge: ['trash', 'Entfernen', 'Behalten'], set_kind: ['check', 'Einordnen', 'Nicht ändern'],
};

export function useSuggestions(status = 'pending') {
  return useQuery({ queryKey: ['suggestions', status], queryFn: () => get<any[]>(`/suggestions?status=${status}`), refetchInterval: 30000 });
}

export function useSuggestionActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => ['suggestions', 'graph', 'dependencies', 'resources', 'overview'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const accept = useMutation({ mutationFn: (b: { ids: string[]; type?: string; strength?: string }) => post('/suggestions/accept', b),
    onSuccess: (r: any) => { refresh(); toast([r.created ? `${r.created} Abhängigkeit(en) übernommen` : '', r.merged ? `${r.merged} Eintrag/Einträge zusammengeführt` : '', r.removed ? `${r.removed} Abhängigkeit(en) entfernt` : '', r.reclassified ? `${r.reclassified} Typ(en) geändert` : '', r.newResources ? `${r.newResources} Ressource(n) angelegt` : ''].filter(Boolean).join(', ') || 'Nichts geändert'); }, onError: (e: Error) => toast(e.message, true) });
  const reject = useMutation({ mutationFn: (ids: string[]) => post('/suggestions/reject', { ids }), onSuccess: () => { refresh(); }, onError: (e: Error) => toast(e.message, true) });
  const analyze = useMutation({ mutationFn: () => post('/suggestions/analyze'), onSuccess: () => { toast('Analyse läuft – neue Vorschläge erscheinen in wenigen Sekunden'); setTimeout(refresh, 4000); } });
  return { accept, reject, analyze };
}

export function targetLabel(s: any) {
  return s.to_name ?? `${s.target?.name} (neu)`;
}

/** Inbox of dependency suggestions with evidence; bulk accept/reject. */
export function SuggestionList({ onWalkthrough }: { onWalkthrough?: () => void }) {
  const { can } = useAuth();
  const [status, setStatus] = useState('pending');
  const [conf, setConf] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const list = useSuggestions(status);
  const { accept, reject, analyze } = useSuggestionActions();
  const rows = useMemo(() => (list.data ?? []).filter((s) => !conf || s.confidence === conf), [list.data, conf]);
  const ids = [...sel].filter((id) => rows.some((r) => r.id === id));
  const sure = rows.filter((r) => r.confidence === 'sure').map((r) => r.id);
  return (
    <>
      <div className="toolbar">
        <div className="tabs">{[['pending', 'Offen'], ['accepted', 'Übernommen'], ['rejected', 'Abgelehnt']].map(([k, l]) => <button key={k} className={`tab ${status === k ? 'active' : ''}`} onClick={() => { setStatus(k); setSel(new Set()); }}>{l}</button>)}</div>
        <select value={conf} onChange={(e) => setConf(e.target.value)} aria-label="Sicherheit"><option value="">Sicherheit: alle</option>{Object.entries(CONF_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <div className="spacer" />
        {can('operator') && status === 'pending' && <>
          <button onClick={() => analyze.mutate()} disabled={analyze.isPending}><Icon name="refresh" />Jetzt analysieren</button>
          {onWalkthrough && rows.length > 0 && <button onClick={onWalkthrough}><Icon name="play" />Walkthrough starten</button>}
          {sure.length > 0 && <button onClick={() => accept.mutate({ ids: sure })}>Alle sicheren übernehmen ({sure.length})</button>}
          <button className="primary" disabled={!ids.length} onClick={() => { accept.mutate({ ids }); setSel(new Set()); }}><Icon name="check" />Übernehmen ({ids.length})</button>
          <button disabled={!ids.length} onClick={() => { reject.mutate(ids); setSel(new Set()); }}>Ablehnen</button>
        </>}
      </div>
      <div className="sub" style={{ marginBottom: 10 }}>
        Quellen: gleiche MAC- oder IP-Adresse = dasselbe Gerät (sicher, wird zusammengeführt), gleicher Hostname (Vermutung), VMware-API (VM läuft auf ESX-Host, VM-Daten auf NAS, Gateway des ESX-Hosts), Routing-Tabelle und Traceroute des Hermes-Hosts (Gateway-Kette bis ins Internet), beobachtete TCP-Verbindungen, Resolver. Bereinigung schlägt das Entfernen falscher alter Abhängigkeiten vor.
        Nichts wird ohne Bestätigung eingetragen; abgelehnte Vorschläge kommen nicht wieder.
      </div>
      <div className="panel flush table-wrap">
        {list.isLoading ? <Empty>Lade…</Empty> : rows.length === 0 ? <Empty>{status === 'pending' ? 'Keine offenen Vorschläge. Hermes analysiert jede Minute; mit einer VMware-Quelle kommen VM-→-Host-Zuordnungen dazu.' : 'Keine Einträge.'}</Empty> : (
          <table className="t">
            <thead><tr>
              {status === 'pending' && <th style={{ width: 28 }}><input type="checkbox" aria-label="Alle" checked={rows.every((r) => sel.has(r.id))} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>}
              <th>Komponente</th><th>Art</th><th>Ziel</th><th>Sicherheit</th><th>Begründung</th><th>Gesehen</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id}>
                {status === 'pending' && <td><input type="checkbox" aria-label="auswählen" checked={sel.has(s.id)} onChange={() => { const n = new Set(sel); n.has(s.id) ? n.delete(s.id) : n.add(s.id); setSel(n); }} /></td>}
                <td><StatusBadge status={s.from_status} label="" /> <Link to={`/resources/${s.from_id}`}>{s.from_name}</Link> <span className="dim">{KIND_LABEL[s.from_kind]}</span></td>
                <td>{s.type === 'same_as' ? <Badge kind="warning">dasselbe Gerät wie</Badge> : s.type === 'remove_edge' ? <Badge kind="critical">entfernen</Badge> : s.type === 'set_kind' ? <Badge kind="info">als {KIND_LABEL[s.data?.kind] ?? s.data?.kind}</Badge> : typeLabel(s.type)}</td>
                <td>{s.type === 'set_kind' ? <span className="dim">{s.data?.rename ? `Name: ${s.data.rename}` : '–'}</span> : s.to_id ? <><StatusBadge status={s.to_status} label="" /> <Link to={`/resources/${s.to_id}`}>{s.to_name}</Link> <span className="dim">{KIND_LABEL[s.to_kind]}</span></>
                  : <><Badge kind="warning">neu</Badge> <span className="mono">{s.target?.host}{s.target?.port ? `:${s.target.port}` : ''}</span> <span className="dim">als {KIND_LABEL[s.target?.kind] ?? s.target?.kind}</span></>}</td>
                <td><Badge kind={CONF_KIND[s.confidence]}>{CONF_LABEL[s.confidence]}</Badge> <span className="dim" style={{ fontSize: 11 }}>{SOURCE_LABEL[s.source]}</span></td>
                <td style={{ maxWidth: 460, fontSize: 12.5 }} className="dim">{s.evidence}</td>
                <td className="dim" style={{ whiteSpace: 'nowrap' }}>{s.observations}× · {ago(s.last_seen_at)}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** Step-by-step review in the Command Center: highlights both ends and the proposed edge in the map. */
export function Walkthrough({ list, index, setIndex, onClose }: { list: any[]; index: number; setIndex: (i: number) => void; onClose: () => void }) {
  const { accept, reject } = useSuggestionActions();
  const [type, setType] = useState<string | null>(null);
  const s = list[index];
  if (!s) {
    return (
      <section className="cc-walk">
        <div className="row"><b>Walkthrough</b><button className="ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Schließen"><Icon name="x" /></button></div>
        <div className="cc-allgood" style={{ marginTop: 8 }}><span className="dot ok" />Alle Vorschläge geprüft.</div>
      </section>
    );
  }
  const next = () => { setType(null); setIndex(index + 1); };
  return (
    <section className="cc-walk">
      <div className="row"><b>Walkthrough</b><span className="dim mono" style={{ fontSize: 11.5 }}>{index + 1} / {list.length}</span>
        <button className="ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Schließen"><Icon name="x" /></button></div>
      <div className="cc-walk-edge">
        <div><span className="dim" style={{ fontSize: 11 }}>{KIND_LABEL[s.from_kind]}</span><b>{s.from_name}</b></div>
        <div className="arrow">
          {s.type === 'same_as' ? <span className="badge warning">= dasselbe Gerät</span>
            : s.type === 'remove_edge' ? <span className="badge critical">✕ entfernen</span>
            : s.type === 'set_kind' ? <span className="badge info">→ {KIND_LABEL[s.data?.kind] ?? s.data?.kind}</span>
            : <select value={type ?? s.type} onChange={(e) => setType(e.target.value)} aria-label="Art">{Object.entries(DEP_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
        </div>
        <div><span className="dim" style={{ fontSize: 11 }}>{s.type === 'set_kind' ? 'neuer Typ' : s.to_id ? KIND_LABEL[s.to_kind] : `neu als ${KIND_LABEL[s.target?.kind] ?? s.target?.kind}`}</span>
          <b>{s.type === 'set_kind' ? `${KIND_LABEL[s.data?.kind] ?? s.data?.kind}${s.data?.rename ? ` („${s.data.rename}“)` : ''}` : targetLabel(s)}</b></div>
      </div>
      <div className="row" style={{ gap: 6, margin: '8px 0' }}><Badge kind={CONF_KIND[s.confidence]}>{CONF_LABEL[s.confidence]}</Badge><span className="dim" style={{ fontSize: 11.5 }}>{SOURCE_LABEL[s.source]} · {s.observations}× gesehen</span></div>
      <div className="cc-msg">{s.evidence}</div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="primary" disabled={accept.isPending} onClick={() => accept.mutate({ ids: [s.id], type: type ?? undefined }, { onSuccess: next })}><Icon name={ACCEPT_LABEL[s.type]?.[0] ?? 'check'} />{ACCEPT_LABEL[s.type]?.[1] ?? 'Übernehmen'}</button>
        <button onClick={() => reject.mutate([s.id], { onSuccess: next })}>{ACCEPT_LABEL[s.type]?.[2] ?? 'Ablehnen'}</button>
        <button className="ghost" onClick={next}>Später</button>
        {index > 0 && <button className="ghost" onClick={() => setIndex(index - 1)}>Zurück</button>}
      </div>
    </section>
  );
}
