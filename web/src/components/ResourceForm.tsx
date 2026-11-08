import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { CRIT_LABEL, CRITS, KIND_LABEL, KINDS } from '../lib/meta';
import { Field, Modal } from './ui';

export interface ResourceDraft {
  id?: string; name: string; display_name?: string | null; kind: string; parent_id?: string | null; environment?: string | null; group_name?: string | null;
  criticality: string; owner?: string | null; tags: string[]; connection: Record<string, any>; notes?: string | null; monitoring_enabled?: boolean; metadata?: Record<string, string>;
}

export function ResourceForm({ initial, onSave, onClose, busy }: { initial: ResourceDraft; onSave: (d: ResourceDraft) => void; onClose: () => void; busy?: boolean }) {
  const [d, setD] = useState<ResourceDraft>(initial);
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [meta, setMeta] = useState(Object.entries(initial.metadata ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  const resources = useQuery({ queryKey: ['resources'], queryFn: () => get<any[]>('/resources') });
  const parents = (resources.data ?? []).filter((r) => r.id !== d.id && ['host', 'vm', 'hypervisor', 'nas', 'router', 'firewall', 'switch', 'platform', 'compose_project', 'service', 'storage'].includes(r.kind));
  const set = (k: keyof ResourceDraft, v: any) => setD({ ...d, [k]: v });
  const conn = (k: string, v: string) => setD({ ...d, connection: { ...d.connection, [k]: v === '' ? undefined : k === 'port' ? Number(v) : v } });
  const save = () => {
    const metadata: Record<string, string> = {};
    for (const line of meta.split('\n')) { const i = line.indexOf('='); if (i > 0) metadata[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    onSave({ ...d, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), metadata, display_name: d.display_name || null, environment: d.environment || null, group_name: d.group_name || null, owner: d.owner || null });
  };
  return (
    <Modal title={d.id ? `Ressource bearbeiten` : 'Ressource anlegen'} onClose={onClose} wide
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!d.name || busy} onClick={save}>Speichern</button></>}>
      {d.id && <div className="callout">Felder, die du hier änderst, gehören ab jetzt dir: die Discovery überschreibt sie nicht mehr.</div>}
      <div className="form-grid">
        <Field label="Name"><input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="z. B. opnsense" /></Field>
        <Field label="Anzeigename"><input value={d.display_name ?? ''} onChange={(e) => set('display_name', e.target.value)} /></Field>
        <Field label="Typ"><select value={d.kind} onChange={(e) => set('kind', e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></Field>
        <Field label="Übergeordnetes System (Host)"><select value={d.parent_id ?? ''} onChange={(e) => set('parent_id', e.target.value || null)}>
          <option value="">–</option>{parents.map((p) => <option key={p.id} value={p.id}>{p.label} ({KIND_LABEL[p.kind]})</option>)}</select></Field>
        <Field label="Umgebung"><input value={d.environment ?? ''} onChange={(e) => set('environment', e.target.value)} placeholder="prod, lab, test" /></Field>
        <Field label="Gruppe / Kategorie"><input value={d.group_name ?? ''} onChange={(e) => set('group_name', e.target.value)} placeholder="Netzwerk, Medien, Smart Home" /></Field>
        <Field label="Kritikalität"><select value={d.criticality} onChange={(e) => set('criticality', e.target.value)}>{CRITS.map((c) => <option key={c} value={c}>{CRIT_LABEL[c]}</option>)}</select></Field>
        <Field label="Verantwortlich"><input value={d.owner ?? ''} onChange={(e) => set('owner', e.target.value)} /></Field>
        <Field className="span2" label="Tags" hint="Kommagetrennt"><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="netzwerk, kritisch" /></Field>
        <Field label="Adresse (Host/IP)" hint="Für Checks: Ping, TCP, TLS, SSH, DNS"><input value={d.connection.host ?? ''} onChange={(e) => conn('host', e.target.value)} placeholder="192.168.1.1" /></Field>
        <Field label="Port"><input type="number" value={d.connection.port ?? ''} onChange={(e) => conn('port', e.target.value)} /></Field>
        <Field className="span2" label="URL" hint="Für HTTP-Checks"><input value={d.connection.url ?? ''} onChange={(e) => conn('url', e.target.value)} placeholder="https://grafana.lab.local" /></Field>
        <Field className="span2" label="Metadaten" hint="Eine Zeile pro Eintrag: schlüssel=wert (z. B. vlan=20, subnet=10.0.20.0/24, standort=Keller)"><textarea rows={3} value={meta} onChange={(e) => setMeta(e.target.value)} /></Field>
        <Field className="span2" label="Notizen"><textarea rows={2} value={d.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
        {!d.id && <label className="check"><input type="checkbox" checked={d.monitoring_enabled ?? true} onChange={(e) => set('monitoring_enabled', e.target.checked)} />Überwachung aktivieren</label>}
      </div>
    </Modal>
  );
}
