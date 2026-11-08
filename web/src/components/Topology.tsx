import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType, useNodesState, useEdgesState,
  type Node, type Edge, type NodeProps, type Connection, BackgroundVariant,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { KIND_LABEL, DEP_TYPES } from '../lib/meta';
import { ago, fmt } from '../lib/format';

export const KIND_CODE: Record<string, string> = {
  wan: 'WAN', router: 'RTR', firewall: 'FW', switch: 'SW', access_point: 'AP', host: 'HOST', hypervisor: 'HV', vm: 'VM', nas: 'NAS', storage: 'STO',
  container: 'CTR', compose_project: 'STK', systemd_service: 'SVC', service: 'APP', endpoint: 'EP', database: 'DB', cache: 'CCH', broker: 'MQ',
  proxy: 'PRX', dns: 'DNS', dhcp: 'DHCP', external_api: 'EXT', backup_job: 'BKP', platform: 'MON', network: 'NET', other: '·',
};
const STATUS_COLOR: Record<string, string> = { ok: '#34d399', warning: '#fbbf24', critical: '#f43f5e', unknown: '#8b98a8', pending: '#64748b', unmonitored: '#3b4756' };
// rank hint so infrastructure sits above hosts above workloads
const KIND_TIER: Record<string, number> = { wan: 0, router: 1, firewall: 1, switch: 2, access_point: 3, network: 2, dns: 3, dhcp: 3, hypervisor: 3, nas: 3, storage: 3, host: 4, vm: 4, platform: 5 };

export interface GraphData { nodes: any[]; edges: any[] }

type NodeData = { r: any; dim: boolean; highlight: 'root' | 'impacted' | 'selected' | null };

const ResourceNode = memo(({ data }: NodeProps<Node<NodeData>>) => {
  const r = data.r;
  const color = STATUS_COLOR[r.status] ?? STATUS_COLOR.unknown;
  const root = !!r.incident_id;
  const impacted = r.impacted_by?.length > 0;
  const symptom = r.root_cause_ids?.length > 0;
  const vit = r.vitals ?? {};
  const sub = vit.cpu_percent != null ? `CPU ${fmt(vit.cpu_percent, 'percent')}${vit.mem_used_percent != null ? ` · RAM ${fmt(vit.mem_used_percent, 'percent')}` : vit.mem_used_bytes != null ? ` · ${fmt(vit.mem_used_bytes, 'bytes')}` : ''}`
    : vit.response_ms != null ? `${fmt(vit.response_ms, 'ms')}` : vit.query_ms != null ? `Query ${fmt(vit.query_ms, 'ms')}` : vit.rtt_avg_ms != null ? `RTT ${fmt(vit.rtt_avg_ms, 'ms')}` : r.address ?? KIND_LABEL[r.kind] ?? r.kind;
  const border = data.highlight === 'selected' ? '#38bdf8' : root ? color : impacted || symptom ? '#fb923c' : r.in_maintenance ? '#a78bfa' : '#223040';
  return (
    <div title={`${r.label}\n${KIND_LABEL[r.kind] ?? r.kind} · ${r.status}${r.status_message ? '\n' + r.status_message : ''}\nseit ${ago(r.status_since)}`}
      style={{
        width: 196, height: 52, display: 'flex', alignItems: 'stretch', background: '#0d141c', border: `1px solid ${border}`, borderStyle: (impacted || symptom) && !root ? 'dashed' : 'solid',
        borderRadius: 9, opacity: data.dim ? 0.22 : 1, boxShadow: root ? `0 0 0 3px ${color}2e` : data.highlight === 'selected' ? '0 0 0 3px #38bdf833' : 'none', cursor: 'pointer', position: 'relative',
      }}>
      {/* bottom: things that depend on this resource connect here */}
      <Handle type="target" position={Position.Bottom} className="hx-handle hx-down" title="Sind abhängig von dieser Ressource" data-label="Sind abhängig von dieser Ressource" />
      <div style={{ width: 4, background: color, flex: 'none', borderRadius: '8px 0 0 8px' }} />
      <div style={{ width: 38, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 9.5, color: '#7d8a99', letterSpacing: '0.04em', borderRight: '1px solid #18222d' }}>{KIND_CODE[r.kind] ?? '·'}</div>
      <div style={{ padding: '6px 9px', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: '#dbe4ee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</div>
        <div style={{ fontSize: 10.5, color: r.status === 'critical' ? '#fda4af' : r.status === 'warning' ? '#fcd34d' : '#7d8a99', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.status === 'critical' || r.status === 'warning' ? (symptom ? 'Folgefehler' : r.status.toUpperCase()) : r.in_maintenance ? 'WARTUNG' : impacted ? 'betroffen' : sub}
        </div>
      </div>
      {/* top: drag from here to the bottom point of a provider = "this depends on that" */}
      <Handle type="source" position={Position.Top} className="hx-handle hx-up" title="Abhängig von" data-label="Abhängig von" />
    </div>
  );
});

const nodeTypes = { res: ResourceNode };

function layout(nodes: any[], edges: any[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: 196, height: 52 });
  // providers above dependents: edge provider → dependent
  for (const e of edges) if (g.hasNode(e.from_id) && g.hasNode(e.to_id)) g.setEdge(e.to_id, e.from_id, { weight: e.type === 'runs_on' ? 3 : 1, minlen: 1 });
  // rank hints for infrastructure without edges between them
  const tiers = nodes.filter((n) => KIND_TIER[n.kind] !== undefined).sort((a, b) => KIND_TIER[a.kind] - KIND_TIER[b.kind]);
  for (let i = 1; i < tiers.length; i++) {
    if (KIND_TIER[tiers[i].kind] > KIND_TIER[tiers[i - 1].kind] && !g.hasEdge(tiers[i - 1].id, tiers[i].id)) g.setEdge(tiers[i - 1].id, tiers[i].id, { weight: 0, minlen: 1, invisible: true });
  }
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) { const p = g.node(n.id); pos.set(n.id, { x: p.x - 98, y: p.y - 26 }); }
  return pos;
}

export interface TopologyProps {
  data: GraphData;
  filter?: (n: any) => boolean;
  selectedId?: string | null;
  onSelect?: (n: any | null) => void;
  onConnect?: (fromId: string, toId: string) => void;
  showLabels?: boolean;
  height?: number | string;
  /** a suggested edge drawn dashed (walkthrough); to may be null for a not-yet-existing target */
  proposed?: { from: string; to: string | null } | null;
}

/**
 * Interactive dependency/infrastructure topology. Arrows point from a dependent to its provider.
 * Status colours come from the server-side state engine; root causes are outlined red, impacted
 * downstream components dashed orange, maintenance purple.
 */
export function Topology({ data, filter, selectedId, onSelect, onConnect, showLabels = true, height = '100%', proposed }: TopologyProps) {
  const visible = useMemo(() => {
    const ns = filter ? data.nodes.filter(filter) : data.nodes;
    const ids = new Set(ns.map((n) => n.id));
    return { nodes: ns, edges: data.edges.filter((e) => ids.has(e.from_id) && ids.has(e.to_id)) };
  }, [data, filter]);
  const structureKey = useMemo(() => visible.nodes.map((n) => n.id).sort().join() + '|' + visible.edges.map((e) => e.id).sort().join(), [visible]);
  const positions = useMemo(() => layout(visible.nodes, visible.edges), [structureKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const focus = useMemo(() => {
    if (proposed) return new Set([proposed.from, ...(proposed.to ? [proposed.to] : [])]);
    if (!selectedId) return null;
    const sel = data.nodes.find((n) => n.id === selectedId);
    if (!sel) return null;
    const set = new Set<string>([selectedId]);
    const down = new Map<string, string[]>(), up = new Map<string, string[]>();
    for (const e of data.edges) { down.set(e.to_id, [...(down.get(e.to_id) ?? []), e.from_id]); up.set(e.from_id, [...(up.get(e.from_id) ?? []), e.to_id]); }
    const walk = (start: string, m: Map<string, string[]>) => { const st = [start]; while (st.length) { const x = st.pop()!; for (const y of m.get(x) ?? []) if (!set.has(y)) { set.add(y); st.push(y); } } };
    walk(selectedId, down); walk(selectedId, up);
    return set;
  }, [selectedId, data, proposed]);

  const build = useCallback((): { nodes: Node<NodeData>[]; edges: Edge[] } => {
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const nodes: Node<NodeData>[] = visible.nodes.map((r) => ({
      id: r.id, type: 'res', position: positions.get(r.id) ?? { x: 0, y: 0 },
      data: { r, dim: !!focus && !focus.has(r.id), highlight: r.id === selectedId || r.id === proposed?.from || r.id === proposed?.to ? 'selected' : null },
    }));
    const edges: Edge[] = visible.edges.map((e) => {
      const provider = byId.get(e.to_id);
      const st = provider?.status ?? 'unknown';
      const failing = st === 'critical';
      const color = failing ? '#f43f5e' : st === 'warning' ? '#fbbf24' : st === 'ok' ? '#2f6b57' : '#3b4756';
      const attrs = e.attributes ?? {};
      const label = showLabels ? [attrs.vlan ? `VLAN ${attrs.vlan}` : null, attrs.subnet, attrs.network, attrs.port, attrs.label].filter(Boolean).join(' · ') || (!['runs_on', 'depends_on', 'network_link', 'other'].includes(e.type) ? DEP_TYPES[e.type] : '') : '';
      const dim = !!focus && !(focus.has(e.from_id) && focus.has(e.to_id));
      return {
        id: e.id, source: e.from_id, target: e.to_id, type: 'smoothstep', animated: failing,
        style: { stroke: color, strokeWidth: e.strength === 'hard' ? 1.6 : 1.1, strokeDasharray: e.strength === 'soft' ? '5 4' : undefined, opacity: dim ? 0.12 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        label: label || undefined, labelStyle: { fill: '#9aa8b8', fontSize: 10, fontFamily: 'var(--mono)' }, labelBgStyle: { fill: '#0b1118' }, labelBgPadding: [4, 2] as [number, number],
      };
    });
    if (proposed?.to && visible.nodes.some((n) => n.id === proposed.from) && visible.nodes.some((n) => n.id === proposed.to)) {
      edges.push({ id: 'proposed', source: proposed.from, target: proposed.to, type: 'smoothstep', animated: true,
        style: { stroke: '#38bdf8', strokeWidth: 2.2, strokeDasharray: '6 4' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#38bdf8', width: 16, height: 16 },
        label: 'Vorschlag', labelStyle: { fill: '#7dd3fc', fontSize: 10.5 }, labelBgStyle: { fill: '#0b1118' }, labelBgPadding: [4, 2] as [number, number] });
    }
    return { nodes, edges };
  }, [visible, positions, focus, selectedId, data, showLabels, proposed]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [fitted, setFitted] = useState('');
  useEffect(() => {
    const b = build();
    // keep positions the user dragged, unless the structure changed
    setNodes((cur) => {
      const curPos = new Map(cur.map((n) => [n.id, n.position]));
      return b.nodes.map((n) => (fitted === structureKey && curPos.has(n.id) ? { ...n, position: curPos.get(n.id)! } : n));
    });
    setEdges(b.edges);
  }, [build]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ height, width: '100%', background: 'var(--bg)' }}>
      <ReactFlow
        key={structureKey}
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onNodeClick={(_, n) => onSelect?.(data.nodes.find((x) => x.id === n.id) ?? null)}
        onPaneClick={() => onSelect?.(null)}
        onConnect={onConnect ? (c: Connection) => c.source && c.target && c.source !== c.target && onConnect(c.source, c.target) : undefined}
        nodesConnectable={!!onConnect}
        connectionLineStyle={{ stroke: '#38bdf8', strokeWidth: 1.6, strokeDasharray: '4 3' }}
        className={onConnect ? 'hx-connectable' : undefined}
        fitView fitViewOptions={{ padding: 0.08, maxZoom: 1.1, minZoom: 0.45 }}
        onInit={() => setFitted(structureKey)}
        minZoom={0.15} maxZoom={2} proOptions={{ hideAttribution: true }} colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#16212c" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable nodeColor={(n) => STATUS_COLOR[(n.data as any)?.r?.status] ?? '#3b4756'} maskColor="#05080cbb" style={{ background: '#0b1118', border: '1px solid #1c2733' }} />
      </ReactFlow>
    </div>
  );
}
