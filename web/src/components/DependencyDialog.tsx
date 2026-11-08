import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../lib/api';
import { DEP_TYPES, KIND_LABEL } from '../lib/meta';
import { Field, Modal, useToast } from './ui';

/** Create or edit one dependency edge: "from" depends on "to". */
export function DependencyDialog({ initial, onClose }: { initial: { id?: string; from_id?: string; to_id?: string; type?: string; strength?: string; attributes?: any; description?: string | null }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const res = useQuery({ queryKey: ['resources'], queryFn: () => get<any[]>('/resources') });
  const [d, setD] = useState({ type: 'depends_on', strength: 'hard', attributes: {}, description: '', ...initial } as any);
  const save = useMutation({
    mutationFn: () => {
      const attributes = Object.fromEntries(Object.entries(d.attributes ?? {}).filter(([, v]) => v));
      return d.id ? patch(`/dependencies/${d.id}`, { type: d.type, strength: d.strength, attributes, description: d.description || null })
        : post('/dependencies', { from_id: d.from_id, to_id: d.to_id, type: d.type, strength: d.strength, attributes, description: d.description || null });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['graph'] }); qc.invalidateQueries({ queryKey: ['dependencies'] }); qc.invalidateQueries({ queryKey: ['resource'] }); toast('Abhängigkeit gespeichert'); onClose(); },
    onError: (e: Error) => toast(e.message, true),
  });
  const opts = (res.data ?? []).slice().sort((a, b) => a.label.localeCompare(b.label));
  const a = (k: string, v: string) => setD({ ...d, attributes: { ...d.attributes, [k]: v } });
  return (
    <Modal title={d.id ? 'Abhängigkeit bearbeiten' : 'Abhängigkeit anlegen'} onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!d.from_id || !d.to_id || d.from_id === d.to_id || save.isPending} onClick={() => save.mutate()}>Speichern</button></>}>
      <div className="form-grid">
        <Field label="Abhängige Komponente (von)"><select value={d.from_id ?? ''} disabled={!!d.id} onChange={(e) => setD({ ...d, from_id: e.target.value })}>
          <option value="">wählen…</option>{opts.map((r) => <option key={r.id} value={r.id}>{r.label} ({KIND_LABEL[r.kind]})</option>)}</select></Field>
        <Field label="Hängt ab von (Anbieter)"><select value={d.to_id ?? ''} disabled={!!d.id} onChange={(e) => setD({ ...d, to_id: e.target.value })}>
          <option value="">wählen…</option>{opts.map((r) => <option key={r.id} value={r.id}>{r.label} ({KIND_LABEL[r.kind]})</option>)}</select></Field>
        <Field label="Art"><select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value })}>{Object.entries(DEP_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Stärke" hint="hart: Ausfall des Anbieters erklärt Ausfall (Ursachenunterdrückung). weich: nur Auswirkung."><select value={d.strength} onChange={(e) => setD({ ...d, strength: e.target.value })}>
          <option value="hard">hart (zwingend)</option><option value="soft">weich (degradiert)</option></select></Field>
        <Field label="Netzwerk"><input value={d.attributes?.network ?? ''} onChange={(e) => a('network', e.target.value)} placeholder="LAN, DMZ, IoT" /></Field>
        <Field label="Subnetz"><input value={d.attributes?.subnet ?? ''} onChange={(e) => a('subnet', e.target.value)} placeholder="10.0.20.0/24" /></Field>
        <Field label="VLAN"><input value={d.attributes?.vlan ?? ''} onChange={(e) => a('vlan', e.target.value)} placeholder="20" /></Field>
        <Field label="Port / Protokoll"><input value={d.attributes?.port ?? ''} onChange={(e) => a('port', e.target.value)} placeholder="tcp/5432" /></Field>
        <Field className="span2" label="Beschreibung"><input value={d.description ?? ''} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
