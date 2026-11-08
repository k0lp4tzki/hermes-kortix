import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType, useNodesState, useEdgesState,
  type Node, type Edge, type NodeProps, type Connection, BackgroundVariant,
} from '@xyflow/react';
import { KIND_LABEL, DEP_TYPES } from '../lib/meta';
import { ago, fmt } from '../lib/format';

export const KIND_CODE: Record<string, string> = {
  wan: 'WAN', router: 'RTR', firewall: 'FW', switch: 'SW', access_point: 'AP', host: 'HOST', hypervisor: 'HV', vm: 'VM', nas: 'NAS', storage: 'STO',
  container: 'CTR', compose_project: 'STK', systemd_service: 'SVC', service: 'APP', endpoint: 'EP', database: 'DB', cache: 'CCH', broker: 'MQ',
  proxy: 'PRX', dns: 'DNS', dhcp: 'DHCP', external_api: 'EXT', backup_job: 'BKP', platform: 'MON', network: 'NET', other: '·',
};
const STATUS_COLOR: Record<string, string> = { ok: '#34d399', warning: '#fbbf24', critical: '#f43f5e', unknown: '#8b98a8', pending: '#64748b', unmonitored: '#3b4756' };

/**
 * Fixed horizontal layers, top to bottom. The network edge (internet, router/gateway, firewall)
 * is always on top, storage is the base at the bottom; edges run between the layers.
 */
export const LAYERS: Array<{ key: string; label: string; kinds: string[] }> = [
  { key: 'internet', label: 'Internet & externe Dienste', kinds: ['wan', 'external_api'] },
  { key: 'network', label: 'Netzwerk', kinds: ['router', 'firewall', 'switch', 'access_point', 'network', 'dns', 'dhcp'] },
  { key: 'hosts', label: 'Hosts & Hypervisoren', kinds: ['hypervisor', 'host', 'endpoint'] },
  { key: 'vms', label: 'Virtuelle Maschinen', kinds: ['vm'] },
  { key: 'apps', label: 'Container & Dienste', kinds: [] },
  { key: 'storage', label: 'Storage', kinds: ['nas', 'storage'] },
];
export function layerOf(kind: string): number {
  const i = LAYERS.findIndex((l) => l.kinds.includes(kind));
  return i < 0 ? LAYERS.findIndex((l) => l.key === 'apps') : i;
}
const NODE_W = 196, NODE_H = 52, GAP_X = 26, GAP_Y = 24, LANE_PAD_TOP = 36, LANE_PAD_BOTTOM = 18, LANE_GAP = 14, PER_ROW = 8;

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
      {/* invisible anchors used to route drawn edges up, down or sideways between layers */}
      {HIDDEN_HANDLES.map((h) => <Handle key={h.id} id={h.id} type={h.type} position={h.pos} isConnectable={false} className="hx-anchor" />)}
      <Handle id="dependents" type="target" position={Position.Bottom} className="hx-handle hx-down" title="Sind abhängig von dieser Ressource" data-label="Sind abhängig von dieser Ressource" />
      <div style={{ width: 4, background: color, flex: 'none', borderRadius: '8px 0 0 8px' }} />
      <div style={{ width: 38, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)', fontSize: 9.5, color: '#7d8a99', letterSpacing: '0.04em', borderRight: '1px solid #18222d' }}>{KIND_CODE[r.kind] ?? '·'}</div>
      <div style={{ padding: '6px 9px', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: '#dbe4ee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</div>
        <div style={{ fontSize: 10.5, color: r.status === 'critical' ? '#fda4af' : r.status === 'warning' ? '#fcd34d' : '#7d8a99', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.status === 'critical' || r.status === 'warning' ? (symptom ? 'Folgefehler' : r.status.toUpperCase()) : r.in_maintenance ? 'WARTUNG' : impacted ? 'betroffen' : sub}
        </div>
      </div>
      {/* top: drag from here to the bottom point of a provider = "this depends on that" */}
      <Handle id="dep" type="source" position={Position.Top} className="hx-handle hx-up" title="Abhängig von" data-label="Abhängig von" />
    </div>
  );
});

const HIDDEN_HANDLES: Array<{ id: string; type: 'source' | 'target'; pos: Position }> = [
  { id: 'ts', type: 'source', pos: Position.Top }, { id: 'tt', type: 'target', pos: Position.Top },
  { id: 'bs', type: 'source', pos: Position.Bottom }, { id: 'bt', type: 'target', pos: Position.Bottom },
  { id: 'ls', type: 'source', pos: Position.Left }, { id: 'lt', type: 'target', pos: Position.Left },
  { id: 'rs', type: 'source', pos: Position.Right }, { id: 'rt', type: 'target', pos: Position.Right },
];

type LaneData = { label: string; count: number; width: number; height: number };
const LaneNode = memo(({ data }: NodeProps<Node<LaneData>>) => (
  <div className="hx-lane" style={{ width: data.width, height: data.height }}>
    <span className="hx-lane-label">{data.label}<span className="dim"> · {data.count}</span></span>
  </div>
));

const nodeTypes = { res: ResourceNode, lane: LaneNode };

interface Layout { pos: Map<string, { x: number; y: number }>; lanes: Array<{ key: string; label: string; count: number; x: number; y: number; width: number; height: number }> }

/**
 * Layered layout: every node sits in the band of its kind; inside a band nodes are ordered by
 * the barycenter of their neighbours (fewer crossings) and wrap into rows of PER_ROW.
 */
function layout(nodes: any[], edges: any[]): Layout {
  const byLayer: any[][] = LAYERS.map(() => []);
  for (const n of nodes) byLayer[layerOf(n.kind)].push(n);
  const parentName = new Map(nodes.map((n) => [n.id, nodes.find((p) => p.id === n.parent_id)?.label ?? '']));
  for (const l of byLayer) l.sort((a, b) => (parentName.get(a.id) ?? '').localeCompare(parentName.get(b.id) ?? '') || a.label.localeCompare(b.label));
  const nbrs = new Map<string, string[]>();
  for (const e of edges) { nbrs.set(e.from_id, [...(nbrs.get(e.from_id) ?? []), e.to_id]); nbrs.set(e.to_id, [...(nbrs.get(e.to_id) ?? []), e.from_id]); }
  const xOf = new Map<string, number>();
  const assignX = () => { for (const l of byLayer) { const w = Math.min(l.length, PER_ROW); l.forEach((n, i) => xOf.set(n.id, (i % PER_ROW) - (w - 1) / 2)); } };
  assignX();
  for (let pass = 0; pass < 4; pass++) {
    for (const l of byLayer) {
      const bary = new Map(l.map((n) => {
        const xs = (nbrs.get(n.id) ?? []).map((m) => xOf.get(m)).filter((x): x is number => x !== undefined);
        return [n.id, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : xOf.get(n.id)!];
      }));
      l.sort((a, b) => bary.get(a.id)! - bary.get(b.id)!);
    }
    assignX();
  }
  const widest = Math.max(1, ...byLayer.map((l) => Math.min(l.length, PER_ROW)));
  const innerW = widest * NODE_W + (widest - 1) * GAP_X;
  const pos = new Map<string, { x: number; y: number }>();
  const lanes: Layout['lanes'] = [];
  let y = 0;
  byLayer.forEach((l, li) => {
    if (!l.length) return;
    const rows = Math.ceil(l.length / PER_ROW);
    const height = LANE_PAD_TOP + rows * NODE_H + (rows - 1) * GAP_Y + LANE_PAD_BOTTOM;
    for (let r = 0; r < rows; r++) {
      const row = l.slice(r * PER_ROW, (r + 1) * PER_ROW);
      const rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
      row.forEach((n, i) => pos.set(n.id, { x: (innerW - rowW) / 2 + i * (NODE_W + GAP_X), y: y + LANE_PAD_TOP + r * (NODE_H + GAP_Y) }));
    }
    lanes.push({ key: LAYERS[li].key, label: LAYERS[li].label, count: l.length, x: -24, y, width: innerW + 48, height });
    y += height + LANE_GAP;
  });
  return { pos, lanes };
}

/** Which anchors an edge uses: provider above → up, below → down, same row → sideways. */
function anchors(from: { x: number; y: number } | undefined, to: { x: number; y: number } | undefined) {
  if (!from || !to) return { sourceHandle: 'ts', targetHandle: 'bt' };
  if (Math.abs(from.y - to.y) < NODE_H / 2) return to.x >= from.x ? { sourceHandle: 'rs', targetHandle: 'lt' } : { sourceHandle: 'ls', targetHandle: 'rt' };
  return to.y < from.y ? { sourceHandle: 'ts', targetHandle: 'bt' } : { sourceHandle: 'bs', targetHandle: 'tt' };
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

  const build = useCallback((): { nodes: Node<any>[]; edges: Edge[] } => {
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const nodes: Node<any>[] = positions.lanes.map((l) => ({
      id: `lane:${l.key}`, type: 'lane', position: { x: l.x, y: l.y }, data: { label: l.label, count: l.count, width: l.width, height: l.height },
      draggable: false, selectable: false, connectable: false, focusable: false, zIndex: -1,
    }));
    nodes.push(...visible.nodes.map((r) => ({
      id: r.id, type: 'res', position: positions.pos.get(r.id) ?? { x: 0, y: 0 },
      data: { r, dim: !!focus && !focus.has(r.id), highlight: r.id === selectedId || r.id === proposed?.from || r.id === proposed?.to ? 'selected' : null },
    })));
    const edges: Edge[] = visible.edges.map((e) => {
      const provider = byId.get(e.to_id);
      const st = provider?.status ?? 'unknown';
      const failing = st === 'critical';
      const color = failing ? '#f43f5e' : st === 'warning' ? '#fbbf24' : st === 'ok' ? '#2f6b57' : '#3b4756';
      const attrs = e.attributes ?? {};
      const label = showLabels ? [attrs.vlan ? `VLAN ${attrs.vlan}` : null, attrs.subnet, attrs.network, attrs.port, attrs.label].filter(Boolean).join(' · ') || (!['runs_on', 'depends_on', 'network_link', 'uses_storage', 'other'].includes(e.type) ? DEP_TYPES[e.type] : '') : '';
      const dim = !!focus && !(focus.has(e.from_id) && focus.has(e.to_id));
      return {
        id: e.id, source: e.from_id, target: e.to_id, ...anchors(positions.pos.get(e.from_id), positions.pos.get(e.to_id)), type: 'smoothstep', animated: failing,
        style: { stroke: color, strokeWidth: e.strength === 'hard' ? 1.6 : 1.1, strokeDasharray: e.strength === 'soft' ? '5 4' : undefined, opacity: dim ? 0.12 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        label: label || undefined, labelStyle: { fill: '#9aa8b8', fontSize: 10, fontFamily: 'var(--mono)' }, labelBgStyle: { fill: '#0b1118' }, labelBgPadding: [4, 2] as [number, number],
      };
    });
    if (proposed?.to && visible.nodes.some((n) => n.id === proposed.from) && visible.nodes.some((n) => n.id === proposed.to)) {
      edges.push({ id: 'proposed', source: proposed.from, target: proposed.to, ...anchors(positions.pos.get(proposed.from), positions.pos.get(proposed.to)), type: 'smoothstep', animated: true,
        style: { stroke: '#38bdf8', strokeWidth: 2.2, strokeDasharray: '6 4' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#38bdf8', width: 16, height: 16 },
        label: 'Vorschlag', labelStyle: { fill: '#7dd3fc', fontSize: 10.5 }, labelBgStyle: { fill: '#0b1118' }, labelBgPadding: [4, 2] as [number, number] });
    }
    return { nodes, edges };
  }, [visible, positions, focus, selectedId, data, showLabels, proposed]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<any>>([]);
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
        onNodeClick={(_, n) => { if (n.type !== 'lane') onSelect?.(data.nodes.find((x) => x.id === n.id) ?? null); }}
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
        <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'lane' ? '#0e161f' : STATUS_COLOR[(n.data as any)?.r?.status] ?? '#3b4756')} maskColor="#05080cbb" style={{ background: '#0b1118', border: '1px solid #1c2733' }} />
      </ReactFlow>
    </div>
  );
}
