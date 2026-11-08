import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DEP_TYPES, KIND_LABEL } from '../lib/meta';
import { Badge, Empty, Icon, StatusBadge } from './ui';
import { DependencyDialog } from './DependencyDialog';
import { Topology } from './Topology';

export function ResourceDeps({ resource }: { resource: any }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const deps = useQuery({ queryKey: ['dependencies', resource.id], queryFn: () => get<any[]>(`/dependencies?resource_id=${resource.id}`) });
  const graph = useQuery({ queryKey: ['graph'], queryFn: () => get('/graph') });
  const [dialog, setDialog] = useState<any | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => del(`/dependencies/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['dependencies'] }); qc.invalidateQueries({ queryKey: ['graph'] }); } });
  const list = (deps.data ?? []).filter((d) => !d.suppressed);
  const up = list.filter((d) => d.from_id === resource.id);
  const down = list.filter((d) => d.to_id === resource.id);
  // neighbourhood: everything connected to this resource (transitively)
  const related = new Set<string>([resource.id]);
  if (graph.data) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of graph.data.edges) {
        if (related.has(e.from_id) !== related.has(e.to_id)) { related.add(e.from_id); related.add(e.to_id); grew = true; }
      }
    }
  }
  const Row = ({ d, side }: { d: any; side: 'to' | 'from' }) => (
    <tr>
      <td><StatusBadge status={d[`${side}_status`]} /></td>
      <td><Link to={`/resources/${d[`${side}_id`]}`}>{d[`${side}_name`]}</Link> <span className="dim">{KIND_LABEL[d[`${side}_kind`]]}</span></td>
      <td>{DEP_TYPES[d.type] ?? d.type}</td><td>{d.strength === 'hard' ? 'hart' : 'weich'}</td>
      <td className="mono dim" style={{ fontSize: 12 }}>{[d.attributes?.network, d.attributes?.subnet, d.attributes?.vlan && `VLAN ${d.attributes.vlan}`, d.attributes?.port].filter(Boolean).join(' · ')}</td>
      <td>{d.origin === 'auto' ? <Badge kind="info">auto</Badge> : 'manuell'}</td>
      <td style={{ textAlign: 'right' }}>{can('operator') && <><button className="sm" onClick={() => setDialog(d)}>Bearbeiten</button> <button className="sm danger" onClick={() => remove.mutate(d.id)}>Entfernen</button></>}</td>
    </tr>
  );
  return (
    <div className="stack">
      {(resource.root_cause_ids?.length > 0 || resource.impacted_by?.length > 0) && <div className="callout warn">{resource.status_message}</div>}
      <div className="grid2">
        <div className="panel flush">
          <div className="panel-head" style={{ padding: '12px 14px 0' }}><h2>Hängt ab von ({up.length})</h2><div className="actions">{can('operator') && <button className="sm" onClick={() => setDialog({ from_id: resource.id })}><Icon name="plus" size={12} />Anbieter</button>}</div></div>
          {up.length ? <table className="t"><tbody>{up.map((d) => <Row key={d.id} d={d} side="to" />)}</tbody></table> : <Empty>Keine eingehenden Abhängigkeiten.</Empty>}
        </div>
        <div className="panel flush">
          <div className="panel-head" style={{ padding: '12px 14px 0' }}><h2>Wird benötigt von ({down.length})</h2><div className="actions">{can('operator') && <button className="sm" onClick={() => setDialog({ to_id: resource.id })}><Icon name="plus" size={12} />Abhängige</button>}</div></div>
          {down.length ? <table className="t"><tbody>{down.map((d) => <Row key={d.id} d={d} side="from" />)}</tbody></table> : <Empty>Nichts hängt von dieser Ressource ab.</Empty>}
        </div>
      </div>
      {graph.data && related.size > 1 && (
        <div className="panel flush" style={{ height: 420, overflow: 'hidden' }}>
          <Topology data={graph.data} filter={(n) => related.has(n.id)} selectedId={resource.id} />
        </div>
      )}
      {dialog && <DependencyDialog initial={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
