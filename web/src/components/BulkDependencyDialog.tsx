import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { DEP_TYPES, KIND_LABEL } from '../lib/meta';
import { Field, Modal, useToast } from './ui';

const INFRA_FIRST = ['firewall', 'router', 'switch', 'wan', 'access_point', 'network', 'dns', 'proxy', 'nas', 'storage', 'hypervisor', 'host', 'database', 'cache', 'broker'];

/** Link (or unlink) many selected resources with one target in one step, e.g. "all depend on the firewall". */
export function BulkDependencyDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const res = useQuery({ queryKey: ['resources'], queryFn: () => get<any[]>('/resources') });
  const [d, setD] = useState({ target_id: '', direction: 'selection_depends_on_target', action: 'add', type: 'network_link', strength: 'hard', network: '', subnet: '', vlan: '', port: '', description: '', q: '' });
  const selected = (res.data ?? []).filter((r) => ids.includes(r.id));
  const targets = useMemo(() => (res.data ?? [])
    .filter((r) => !d.q || r.label.toLowerCase().includes(d.q.toLowerCase()))
    .sort((a, b) => {
      const ia = INFRA_FIRST.indexOf(a.kind), ib = INFRA_FIRST.indexOf(b.kind);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.label.localeCompare(b.label);
    }), [res.data, d.q]);
  const target = (res.data ?? []).find((r) => r.id === d.target_id);
  const effective = selected.filter((r) => r.id !== d.target_id);
  const save = useMutation({
    mutationFn: () => post('/dependencies/bulk', {
      ids, target_id: d.target_id, direction: d.direction, action: d.action, type: d.type, strength: d.strength,
      attributes: Object.fromEntries(Object.entries({ network: d.network, subnet: d.subnet, vlan: d.vlan, port: d.port }).filter(([, v]) => v)),
      description: d.description || null,
    }),
    onSuccess: (r: any) => {
      ['graph', 'dependencies', 'resources', 'resource'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast(d.action === 'add' ? `${r.edges} Abhängigkeiten gesetzt` : `${r.changed} Abhängigkeiten entfernt`);
      onDone();
    },
    onError: (e: Error) => toast(e.message, true),
  });
  const set = (k: string, v: string) => setD({ ...d, [k]: v });
  return (
    <Modal title={`Abhängigkeit für ${ids.length} Einträge`} wide onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button>
        <button className={d.action === 'remove' ? 'danger' : 'primary'} disabled={!d.target_id || !effective.length || save.isPending} onClick={() => save.mutate()}>
          {d.action === 'add' ? `${effective.length} Abhängigkeiten setzen` : `${effective.length} Abhängigkeiten entfernen`}</button></>}>
      <div className="form-grid">
        <Field label="Aktion"><select value={d.action} onChange={(e) => set('action', e.target.value)}><option value="add">hinzufügen / aktualisieren</option><option value="remove">entfernen</option></select></Field>
        <Field label="Richtung"><select value={d.direction} onChange={(e) => set('direction', e.target.value)}>
          <option value="selection_depends_on_target">markierte hängen ab von …</option>
          <option value="target_depends_on_selection">… hängt von den markierten ab</option></select></Field>
        <Field className="span2" label={d.direction === 'selection_depends_on_target' ? 'Anbieter (z. B. Firewall)' : 'Abhängige Komponente'}>
          <div className="row"><input placeholder="suchen" value={d.q} onChange={(e) => set('q', e.target.value)} style={{ width: 160 }} />
            <select value={d.target_id} onChange={(e) => set('target_id', e.target.value)} style={{ flex: 1 }}>
              <option value="">wählen…</option>{targets.map((r) => <option key={r.id} value={r.id}>{r.label} ({KIND_LABEL[r.kind] ?? r.kind})</option>)}</select></div></Field>
        <Field label="Art"><select value={d.type} onChange={(e) => set('type', e.target.value)}>{Object.entries(DEP_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {d.action === 'add' && <>
          <Field label="Stärke" hint="hart: Ausfall erklärt Folgefehler · weich: nur Auswirkung"><select value={d.strength} onChange={(e) => set('strength', e.target.value)}><option value="hard">hart</option><option value="soft">weich</option></select></Field>
          <Field label="Netzwerk"><input value={d.network} onChange={(e) => set('network', e.target.value)} placeholder="LAN, DMZ" /></Field>
          <Field label="Subnetz"><input value={d.subnet} onChange={(e) => set('subnet', e.target.value)} placeholder="10.0.20.0/24" /></Field>
          <Field label="VLAN"><input value={d.vlan} onChange={(e) => set('vlan', e.target.value)} /></Field>
          <Field label="Port / Protokoll"><input value={d.port} onChange={(e) => set('port', e.target.value)} /></Field>
        </>}
      </div>
      <div className="callout">
        {target ? <><b>Vorschau:</b> {effective.length} × {d.direction === 'selection_depends_on_target' ? <>„markierter Eintrag“ → <b>{target.label}</b></> : <><b>{target.label}</b> → „markierter Eintrag“</>} ({DEP_TYPES[d.type]})
          {selected.length !== effective.length && <span className="dim"> · {target.label} selbst wird übersprungen</span>}</> : 'Ziel wählen, um die Vorschau zu sehen.'}
        <div className="mono dim" style={{ fontSize: 11.5, marginTop: 6, maxHeight: 110, overflow: 'auto' }}>{effective.map((r) => <div key={r.id}>{r.label}</div>)}</div>
        {d.action === 'remove' && <div className="dim" style={{ marginTop: 6 }}>Automatisch erkannte Kanten werden ausgeblendet statt gelöscht und lassen sich unter Abhängigkeiten → Liste wiederherstellen.</div>}
      </div>
    </Modal>
  );
}
