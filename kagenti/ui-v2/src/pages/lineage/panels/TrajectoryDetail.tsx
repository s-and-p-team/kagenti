// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0

import React, { useMemo, useState, useCallback } from 'react';
import {
  Button,
  Spinner,
  Alert,
  Title,
  Tabs,
  Tab,
  TabTitleText,
} from '@patternfly/react-core';
import {
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
} from '@patternfly/react-table';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery } from '@tanstack/react-query';

import { lineageService } from '@/services/lineageService';
import { configService } from '@/services';
import type { Hop, Run } from '../types';

// ─── Color constants ─────────────────────────────────────────────────────────

const HOP_COLORS: Record<string, string> = {
  principal_to_agent: '#9c59b6',
  agent_to_agent:     '#2980b9',
  agent_to_tool:      '#27ae60',
  agent_to_service:   '#607d8b',  // CHAIN: muted blue-grey (protocol/setup calls)
  agent_to_llm:       '#e67e22',
};

const CHAIN_KINDS = new Set(['agent_to_service']);

const KNOWN_KINDS = new Set(Object.keys(HOP_COLORS));

const NODE_BG: Record<string, string> = {
  source: '#4a235a',
  agent:  '#1a3a5c',
  llm:    '#7e5109',
  tool:   '#1e5631',
};

const NODE_LABEL: Record<string, string> = {
  source: 'principal',
  agent:  'agent',
  llm:    'llm',
  tool:   'tool',
};

// ─── Column layout ────────────────────────────────────────────────────────────

const COL_X: Record<string, number> = {
  source: 80,
  agent:  300,
  llm:    520,
  tool:   740,
};
const NODE_W    = 160;
const NODE_H    = 48;
const VERT_GAP  = 90;

// ─── Node classification ──────────────────────────────────────────────────────

function classifyNodes(hops: Hop[]): Map<string, 'source' | 'agent' | 'llm' | 'tool'> {
  const isTarget     = new Set<string>();
  const isLLMTarget  = new Set<string>();
  const isToolTarget = new Set<string>();
  for (const h of hops) {
    isTarget.add(h.target_id);
    if (h.hop_kind === 'agent_to_llm')                                    isLLMTarget.add(h.target_id);
    if (h.hop_kind === 'agent_to_tool' || h.hop_kind === 'agent_to_service') isToolTarget.add(h.target_id);
  }
  const all = new Set<string>();
  for (const h of hops) {
    if (h.source_id) all.add(h.source_id);
    all.add(h.target_id);
  }

  const result = new Map<string, 'source' | 'agent' | 'llm' | 'tool'>();
  for (const id of all) {
    if (isLLMTarget.has(id))        result.set(id, 'llm');
    else if (isToolTarget.has(id))  result.set(id, 'tool');
    else if (!isTarget.has(id))     result.set(id, 'source');
    else                            result.set(id, 'agent');
  }
  return result;
}

function buildHopIndex(hops: Hop[]): Map<string, Hop[]> {
  const idx = new Map<string, Hop[]>();
  const add = (id: string, h: Hop) => {
    const arr = idx.get(id) ?? [];
    arr.push(h);
    idx.set(id, arr);
  };
  for (const h of hops) {
    if (h.source_id) add(h.source_id, h);
    add(h.target_id, h);
  }
  return idx;
}

// ─── Graph builder (custom layout — no dagre) ─────────────────────────────────

function buildGraph(hops: Hop[]): { nodes: Node[]; edges: Edge[] } {
  const nodeTypes = classifyNodes(hops);
  const hopIdx    = buildHopIndex(hops);
  const byCol: Record<string, string[]> = { source: [], agent: [], llm: [], tool: [] };
  for (const [id, t] of nodeTypes) byCol[t].push(id);

  // Center each column's nodes around the same vertical midpoint.
  // For N nodes: positions run from center - floor(N/2)*gap to center + floor(N/2)*gap.
  const cols = ['source', 'agent', 'llm', 'tool'] as const;
  const maxN = Math.max(1, ...cols.map(col => byCol[col].length));
  const centerY = ((maxN - 1) / 2) * VERT_GAP;

  const nodeY = new Map<string, number>();
  for (const col of cols) {
    const ids = byCol[col];
    const n = ids.length;
    for (let i = 0; i < n; i++) {
      nodeY.set(ids[i], centerY + (i - (n - 1) / 2) * VERT_GAP);
    }
  }

  const nodes: Node[] = [...nodeTypes.keys()].map(id => ({
    id,
    position: { x: COL_X[nodeTypes.get(id)!] - NODE_W / 2, y: nodeY.get(id) ?? 0 },
    data: { label: id, nodeType: nodeTypes.get(id)!, hops: hopIdx.get(id) ?? [] },
    type: 'serviceNode',
  }));

  // Deduplicate: one visual edge per unique (source, target) pair; keep all hops
  const edgeMap = new Map<string, Hop[]>();
  for (const h of hops) {
    if (!h.source_id) continue;
    const key = `${h.source_id}\0${h.target_id}`;
    const arr = edgeMap.get(key) ?? [];
    arr.push(h);
    edgeMap.set(key, arr);
  }

  const edges: Edge[] = [...edgeMap.values()].map((edgeHops, i) => {
    const first = edgeHops[0];
    const count = edgeHops.length;
    return {
      id:     `edge-${i}`,
      source:  first.source_id!,
      target:  first.target_id,
      type:   'smoothstep',
      data: { hops: edgeHops },
      label:  count > 1 ? `×${count}` : undefined,
      labelStyle:   { fill: '#aaa', fontSize: 11 },
      labelBgStyle: { fill: 'transparent' },
      style: { stroke: HOP_COLORS[first.hop_kind] ?? '#888', strokeWidth: 3 },
    };
  });

  return { nodes, edges };
}

// ─── Custom node ──────────────────────────────────────────────────────────────

function ServiceNode({ data }: { data: { label: string; nodeType: string } }) {
  return (
    <>
      <Handle type="target" position={Position.Left}  style={{ background: '#888' }} />
      <div style={{
        background: NODE_BG[data.nodeType] ?? '#1a1a2e',
        color: '#e8e8e8',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 12,
        fontWeight: 500,
        textAlign: 'center',
        width: NODE_W,
        minHeight: NODE_H,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid #556',
        cursor: 'pointer',
        gap: 2,
      }}>
        <div style={{ fontSize: 9, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {NODE_LABEL[data.nodeType]}
        </div>
        <div style={{ wordBreak: 'break-all' }}>{data.label}</div>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: '#888' }} />
    </>
  );
}

const NODE_TYPES = { serviceNode: ServiceNode };

// ─── Detail panel ─────────────────────────────────────────────────────────────

const ATTR_GROUPS: [string, string[]][] = [
  ['Identity', ['openinference.span.kind', 'gen_ai.system', 'gen_ai.agent.name', 'llm.model_name', 'gen_ai.request.model', 'tool.name']],
  ['Input',    ['input.value', 'gen_ai.prompt', 'mlflow.spanInputs']],
  ['Output',   ['output.value', 'gen_ai.completion', 'mlflow.spanOutputs']],
  ['Tokens',   ['llm.token_count.prompt', 'llm.token_count.completion', 'llm.token_count.total', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens']],
  ['Trust',    ['trust.principal_id', 'trust.source_id', 'trust.target_id', 'trust.hop_kind', 'gen_ai.conversation.id']],
];
const GROUPED_KEYS = new Set(ATTR_GROUPS.flatMap(([, ks]) => ks));

function HopDetailContent({ hop, traceId, phoenixUrl }: { hop: Hop; traceId?: string; phoenixUrl?: string }) {
  const attrs = hop.attrs ?? {};
  return (
    <>
      <dl style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: '4px 8px', marginBottom: 12, color: '#333' }}>
        <dt style={{ color: '#666', fontWeight: 500 }}>Source</dt>   <dd style={{ margin: 0 }}>{hop.source_id ?? '—'}</dd>
        <dt style={{ color: '#666', fontWeight: 500 }}>Target</dt>   <dd style={{ margin: 0 }}>{hop.target_id}</dd>
        <dt style={{ color: '#666', fontWeight: 500 }}>Started</dt>  <dd style={{ margin: 0 }}>{new Date(hop.started_at).toLocaleString()}</dd>
        {hop.duration_ms != null && <>
          <dt style={{ color: '#666', fontWeight: 500 }}>Duration</dt><dd style={{ margin: 0 }}>{hop.duration_ms} ms</dd>
        </>}
      </dl>
      <div style={{ borderTop: '1px solid #e8e8e8', paddingTop: 10 }}>
        {ATTR_GROUPS.map(([group, keys]) => {
          const present = keys.filter(k => attrs[k] != null);
          if (!present.length) return null;
          return (
            <div key={group} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5, fontWeight: 600 }}>{group}</div>
              {present.map(k => (
                <div key={k} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 11, color: '#1976d2', marginBottom: 2 }}>{k}</div>
                  <div style={{ fontSize: 13, color: '#222', wordBreak: 'break-all', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto', background: '#f4f4f4', padding: '4px 8px', borderRadius: 4, border: '1px solid #e0e0e0' }}>
                    {String(attrs[k]).length > 600 ? String(attrs[k]).slice(0, 600) + ' …' : String(attrs[k])}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
        {(() => {
          const others = Object.entries(attrs).filter(([k]) => !GROUPED_KEYS.has(k));
          if (!others.length) return null;
          return (
            <div>
              <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5, fontWeight: 600 }}>Other</div>
              {others.map(([k, v]) => (
                <div key={k} style={{ fontSize: 12, color: '#444', marginBottom: 3 }}>
                  <span style={{ color: '#1976d2', marginRight: 6 }}>{k}</span>
                  {String(v).slice(0, 100)}
                </div>
              ))}
            </div>
          );
        })()}
        {phoenixUrl && traceId && hop.hop_kind === 'agent_to_llm' && (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #e8e8e8' }}>
            <a
              href={`${phoenixUrl.replace(/\/$/, '')}/projects/default/traces/${traceId}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: '#1976d2', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              🔍 View prompt &amp; completion in Phoenix →
            </a>
          </div>
        )}
      </div>
    </>
  );
}

function HopDetailPanel({ hop, onClose, traceId, phoenixUrl }: { hop: Hop; onClose: () => void; traceId?: string; phoenixUrl?: string }) {
  return (
    <div style={{ width: 380, flexShrink: 0, overflowY: 'auto', background: '#ffffff', border: '1px solid #d2d2d2', borderRadius: 8, padding: 16, fontSize: 13, color: '#222' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <span style={{ background: HOP_COLORS[hop.hop_kind] ?? '#888', color: '#fff', fontSize: 11, padding: '3px 10px', borderRadius: 12, fontWeight: 600 }}>
          {hop.hop_kind}
        </span>
        <Button variant="plain" onClick={onClose} style={{ minWidth: 'auto', padding: '0 4px', color: '#555', fontSize: 16 }}>×</Button>
      </div>
      <HopDetailContent hop={hop} traceId={traceId} phoenixUrl={phoenixUrl} />
    </div>
  );
}

function EdgeHopsPanel({ hops, onClose, traceId, phoenixUrl }: { hops: Hop[]; onClose: () => void; traceId?: string; phoenixUrl?: string }) {
  const [activeTab, setActiveTab] = useState(0);
  const hop = hops[Math.min(activeTab, hops.length - 1)];
  return (
    <div style={{ width: 380, flexShrink: 0, overflowY: 'auto', background: '#ffffff', border: '1px solid #d2d2d2', borderRadius: 8, padding: 16, fontSize: 13, color: '#222' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ background: HOP_COLORS[hop.hop_kind] ?? '#888', color: '#fff', fontSize: 11, padding: '3px 10px', borderRadius: 12, fontWeight: 600 }}>
            {hop.hop_kind}
          </span>
          {hops.length > 1 && (
            <span style={{ fontSize: 11, color: '#888' }}>×{hops.length} calls</span>
          )}
        </div>
        <Button variant="plain" onClick={onClose} style={{ minWidth: 'auto', padding: '0 4px', color: '#555', fontSize: 16 }}>×</Button>
      </div>
      {hops.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          {hops.map((h, i) => (
            <button
              key={i}
              onClick={() => setActiveTab(i)}
              style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 10, cursor: 'pointer',
                border: '1px solid',
                background: activeTab === i ? (HOP_COLORS[h.hop_kind] ?? '#888') : 'transparent',
                color:      activeTab === i ? '#fff' : '#555',
                borderColor: HOP_COLORS[h.hop_kind] ?? '#888',
              }}
            >
              #{i + 1} · {new Date(h.started_at).toLocaleTimeString()}
              {h.duration_ms != null ? ` · ${h.duration_ms}ms` : ''}
            </button>
          ))}
        </div>
      )}
      <HopDetailContent hop={hop} traceId={traceId} phoenixUrl={phoenixUrl} />
    </div>
  );
}

function NodeHopsPanel({ nodeId, nodeType, hops, onClose, onSelectHop }: {
  nodeId: string; nodeType: string; hops: Hop[];
  onClose: () => void; onSelectHop: (h: Hop) => void;
}) {
  return (
    <div style={{ width: 380, flexShrink: 0, overflowY: 'auto', background: '#ffffff', border: '1px solid #d2d2d2', borderRadius: 8, padding: 16, fontSize: 13, color: '#222' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: NODE_BG[nodeType] ?? '#555', color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 10 }}>{nodeType}</span>
          <span style={{ color: '#111', fontWeight: 600 }}>{nodeId}</span>
        </div>
        <Button variant="plain" onClick={onClose} style={{ minWidth: 'auto', padding: '0 4px', color: '#555', fontSize: 16 }}>×</Button>
      </div>
      <div style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>{hops.length} span{hops.length !== 1 ? 's' : ''} — click to inspect</div>
      {hops.map((h, i) => (
        <div key={h.hop_id ?? i} onClick={() => onSelectHop(h)}
          style={{ cursor: 'pointer', padding: 10, borderRadius: 6, border: '1px solid #e0e0e0', marginBottom: 8, background: '#fafafa' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#1976d2'; e.currentTarget.style.background = '#f0f7ff'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#e0e0e0'; e.currentTarget.style.background = '#fafafa'; }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: HOP_COLORS[h.hop_kind] ?? '#555', fontWeight: 600, fontSize: 12 }}>{h.hop_kind}</span>
            {h.duration_ms != null && <span style={{ color: '#888', fontSize: 12 }}>{h.duration_ms} ms</span>}
          </div>
          <div style={{ color: '#444', fontSize: 13 }}>{h.source_id ?? '—'} → {h.target_id}</div>
          {Boolean(h.attrs?.['input.value'] || h.attrs?.['gen_ai.prompt']) && (
            <div style={{ color: '#666', fontSize: 12, marginTop: 4 }}>
              ↳ {String(h.attrs['input.value'] ?? h.attrs['gen_ai.prompt']).slice(0, 70)}…
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

type SelectedItem =
  | { kind: 'hop';  hop: Hop }
  | { kind: 'edge'; hops: Hop[] }
  | { kind: 'node'; nodeId: string; nodeType: string; hops: Hop[] };

function DetailPanel({ item, onClose, onSelectHop, traceId, phoenixUrl }: { item: SelectedItem; onClose: () => void; onSelectHop: (h: Hop) => void; traceId?: string; phoenixUrl?: string }) {
  if (item.kind === 'hop')  return <HopDetailPanel hop={item.hop} onClose={onClose} traceId={traceId} phoenixUrl={phoenixUrl} />;
  if (item.kind === 'edge') return <EdgeHopsPanel hops={item.hops} onClose={onClose} traceId={traceId} phoenixUrl={phoenixUrl} />;
  return <NodeHopsPanel nodeId={item.nodeId} nodeType={item.nodeType} hops={item.hops} onClose={onClose} onSelectHop={onSelectHop} />;
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function HopLegend() {
  return (
    <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888', alignItems: 'center', marginTop: 4 }}>
      {Object.entries(HOP_COLORS).map(([kind, color]) => (
        <span key={kind} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <svg width={28} height={6}><line x1={0} y1={3} x2={28} y2={3} stroke={color} strokeWidth={3} /></svg>
          {kind}
        </span>
      ))}
    </div>
  );
}

// ─── Graph view ───────────────────────────────────────────────────────────────

function GraphView({ hops, onSelect }: { hops: Hop[]; onSelect: (item: SelectedItem) => void }) {
  const knownHops = useMemo(() => hops.filter(h => KNOWN_KINDS.has(h.hop_kind)), [hops]);
  const { nodes, edges } = useMemo(() => buildGraph(knownHops), [knownHops]);

  const handleEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    const hops = edge.data?.hops as Hop[] | undefined;
    if (hops?.length) onSelect({ kind: 'edge', hops });
  }, [onSelect]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const { nodeType, hops: nodeHops } = node.data as { nodeType: string; hops: Hop[] };
    onSelect({ kind: 'node', nodeId: node.id, nodeType, hops: nodeHops });
  }, [onSelect]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onEdgeClick={handleEdgeClick}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.1 }}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

// ─── Sequence diagram (SVG) ───────────────────────────────────────────────────

const SEQ = {
  padLeft:     20,
  boxW:        140,
  boxH:        36,
  boxTop:      10,
  colSpacing:  190,
  lifelineTop: 50,
  evtH:        52,
  arrowSize:   7,
};

function seqEntityX(i: number) {
  return SEQ.padLeft + SEQ.boxW / 2 + i * SEQ.colSpacing;
}

function Arrowhead({ x, y, toRight, color }: { x: number; y: number; toRight: boolean; color: string }) {
  const s = SEQ.arrowSize;
  if (toRight) return <polygon points={`${x - s},${y - s / 2} ${x},${y} ${x - s},${y + s / 2}`} fill={color} />;
  return <polygon points={`${x + s},${y - s / 2} ${x},${y} ${x + s},${y + s / 2}`} fill={color} />;
}

type SeqEvent = { kind: 'request' | 'response'; hop: Hop; time: number };

function ChainToggle({ show, onToggle, count }: { show: boolean; onToggle: () => void; count: number }) {
  return (
    <button
      onClick={onToggle}
      style={{
        fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', border: '1px solid',
        background: show ? HOP_COLORS['agent_to_service'] : 'transparent',
        color: show ? '#fff' : HOP_COLORS['agent_to_service'],
        borderColor: HOP_COLORS['agent_to_service'],
      }}
    >
      CHAIN {show ? '✓' : `(${count} hidden)`}
    </button>
  );
}

function SequenceView({ hops, onSelect }: { hops: Hop[]; onSelect: (item: SelectedItem) => void }) {
  const [hoveredHop, setHoveredHop] = useState<string | null>(null);
  const [showChain, setShowChain] = useState(false);

  const knownHops = useMemo(() => hops.filter(h => KNOWN_KINDS.has(h.hop_kind)), [hops]);
  const visibleHops = useMemo(
    () => showChain ? knownHops : knownHops.filter(h => !CHAIN_KINDS.has(h.hop_kind)),
    [knownHops, showChain]
  );
  const chainCount = useMemo(() => knownHops.filter(h => CHAIN_KINDS.has(h.hop_kind)).length, [knownHops]);
  const nodeTypes = useMemo(() => classifyNodes(visibleHops), [visibleHops]);

  const entities = useMemo(() => {
    // Order strictly by first appearance in the time-sorted hop list so the
    // sequence diagram reads left-to-right in call order (trip-demo first,
    // then travel-advisor, then the agents it calls, etc.).
    const seen = new Map<string, number>();
    visibleHops.forEach((h, i) => {
      if (h.source_id && !seen.has(h.source_id)) seen.set(h.source_id, i);
      if (!seen.has(h.target_id)) seen.set(h.target_id, i);
    });
    return [...seen.keys()].sort((a, b) => (seen.get(a) ?? 0) - (seen.get(b) ?? 0));
  }, [visibleHops]);

  const entityX = useMemo(() => {
    const m = new Map<string, number>();
    entities.forEach((id, i) => m.set(id, seqEntityX(i)));
    return m;
  }, [entities]);

  const events = useMemo((): SeqEvent[] => {
    const evts: SeqEvent[] = [];
    for (const h of visibleHops) {
      const t = new Date(h.started_at).getTime();
      evts.push({ kind: 'request',  hop: h, time: t });
      evts.push({ kind: 'response', hop: h, time: t + (h.duration_ms ?? 0) });
    }
    return evts.sort((a, b) => a.time - b.time || (a.kind === 'request' ? -1 : 1));
  }, [visibleHops]);

  const svgW  = SEQ.padLeft * 2 + entities.length * SEQ.colSpacing;
  const bodyH = events.length * SEQ.evtH + 20;

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
      {/* Chain toggle */}
      <div style={{ padding: '6px 8px', background: '#0f1117', display: 'flex', alignItems: 'center', gap: 8 }}>
        <ChainToggle show={showChain} onToggle={() => setShowChain(v => !v)} count={chainCount} />
      </div>
      {/* Sticky header */}
      <svg width={svgW} height={SEQ.lifelineTop} style={{ display: 'block', position: 'sticky', top: 33, zIndex: 10, background: '#0f1117' }}>
        {entities.map((id, i) => {
          const cx = seqEntityX(i);
          const type = nodeTypes.get(id) ?? 'agent';
          return (
            <g key={id}>
              <rect x={cx - SEQ.boxW / 2} y={SEQ.boxTop} width={SEQ.boxW} height={SEQ.boxH} rx={5} fill={NODE_BG[type]} stroke="#444" strokeWidth={1} />
              <text x={cx} y={SEQ.boxTop + SEQ.boxH / 2 - 5} dominantBaseline="middle" textAnchor="middle" fill="#e0e0e0" fontSize={10} fontWeight="600">
                {id.length > 18 ? id.slice(0, 17) + '…' : id}
              </text>
              <text x={cx} y={SEQ.boxTop + SEQ.boxH / 2 + 8} dominantBaseline="middle" textAnchor="middle" fill="#888" fontSize={8}>
                {NODE_LABEL[type] ?? type}
              </text>
              <line x1={cx} y1={SEQ.boxTop + SEQ.boxH} x2={cx} y2={SEQ.lifelineTop} stroke="#333" strokeWidth={1} strokeDasharray="4,4" />
            </g>
          );
        })}
      </svg>

      {/* Scrollable body */}
      <svg width={svgW} height={bodyH} style={{ display: 'block', fontFamily: 'monospace' }}>
        {entities.map((id, i) => {
          const cx = seqEntityX(i);
          return <line key={`ll-${id}`} x1={cx} y1={0} x2={cx} y2={bodyH - 20} stroke="#333" strokeWidth={1} strokeDasharray="4,4" />;
        })}

        {events.map((evt, i) => {
          const { kind, hop: h } = evt;
          const isReq = kind === 'request';
          const srcId = isReq ? (h.source_id ?? '') : h.target_id;
          const dstId = isReq ? h.target_id : (h.source_id ?? '');
          const cx    = entityX.get(srcId) ?? (entities.length > 0 ? seqEntityX(0) : 0);
          const tx    = entityX.get(dstId) ?? 0;
          const y     = i * SEQ.evtH + 16;
          const color = HOP_COLORS[h.hop_kind] ?? '#888';
          const toRight = cx <= tx;
          const isHovered = hoveredHop === h.hop_id;
          const midX = (cx + tx) / 2;

          return (
            <g key={`${h.hop_id ?? i}-${kind}`}
              onClick={() => onSelect({ kind: 'hop', hop: h })}
              onMouseEnter={() => setHoveredHop(h.hop_id)}
              onMouseLeave={() => setHoveredHop(null)}
              style={{ cursor: 'pointer' }}
            >
              {isHovered && (
                <rect x={Math.min(cx, tx) - 8} y={y - 14} width={Math.abs(tx - cx) + 16} height={SEQ.evtH - 8} rx={4} fill="rgba(255,255,255,0.05)" stroke="#2a3f6f" strokeWidth={1} />
              )}
              <line x1={cx} y1={y} x2={tx} y2={y} stroke={color} strokeWidth={isReq ? 2 : 1.5} strokeDasharray={isReq ? undefined : '5,3'} opacity={isReq ? 1 : 0.7} />
              <Arrowhead x={toRight ? tx : tx} y={y} toRight={toRight} color={color} />
              {isReq ? (
                <text x={midX} y={y - 6} textAnchor="middle" fill={color} fontSize={9} fontWeight="600">
                  {h.hop_kind.replace('agent_to_', '').replace('principal_to_', '→')}
                </text>
              ) : (
                h.duration_ms != null && (
                  <text x={midX} y={y - 6} textAnchor="middle" fill={color} fontSize={8} opacity={0.7}>{h.duration_ms} ms</text>
                )
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Hop log (table) ──────────────────────────────────────────────────────────

function HopLog({ hops, onSelect }: { hops: Hop[]; onSelect: (item: SelectedItem) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showChain, setShowChain] = useState(false);

  const sorted = useMemo(
    () => [...hops].sort((a, b) => a.started_at.localeCompare(b.started_at)),
    [hops]
  );
  const chainCount = useMemo(() => sorted.filter((h: Hop) => CHAIN_KINDS.has(h.hop_kind)).length, [sorted]);
  const visible = useMemo(
    () => showChain ? sorted : sorted.filter((h: Hop) => !CHAIN_KINDS.has(h.hop_kind)),
    [sorted, showChain]
  );

  const handleClick = (hop: Hop) => {
    setSelectedId(hop.hop_id);
    onSelect({ kind: 'hop', hop });
  };
  return (
    <div>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #e8e8e8', display: 'flex', alignItems: 'center', gap: 8 }}>
        <ChainToggle show={showChain} onToggle={() => setShowChain((v: boolean) => !v)} count={chainCount} />
      </div>
      <Table aria-label="Hop log" variant="compact">
        <Thead>
          <Tr><Th>#</Th><Th>Time</Th><Th>Source</Th><Th>Target</Th><Th>Kind</Th><Th modifier="nowrap">Duration</Th></Tr>
        </Thead>
        <Tbody>
          {visible.map((hop: Hop, i: number) => (
            <Tr
              key={hop.hop_id ?? i}
              isClickable
              isRowSelected={selectedId === hop.hop_id}
              onRowClick={() => handleClick(hop)}
            >
              <Td>{i + 1}</Td>
              <Td style={{ fontSize: '0.75em', whiteSpace: 'nowrap' }}>{new Date(hop.started_at).toLocaleTimeString()}</Td>
              <Td><code style={{ fontSize: '0.8em' }}>{hop.source_id || '—'}</code></Td>
              <Td><code style={{ fontSize: '0.8em' }}>{hop.target_id}</code></Td>
              <Td>
                <span style={{ background: HOP_COLORS[hop.hop_kind] ?? '#555', color: '#fff', padding: '1px 6px', borderRadius: 3, fontSize: '0.75em', whiteSpace: 'nowrap' }}>
                  {hop.hop_kind.replace(/_/g, ' ')}
                </span>
              </Td>
              <Td>{hop.duration_ms != null ? `${hop.duration_ms}ms` : '—'}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  run: Run;
  onBack: () => void;
}

export const TrajectoryDetail: React.FC<Props> = ({ run, onBack }) => {
  const [activeView, setActiveView] = useState(0);
  const [selected, setSelected]     = useState<SelectedItem | null>(null);

  const { data: hops, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-trajectory', run.run_id],
    queryFn: () => lineageService.getTrajectory(run.run_id),
    staleTime: 30_000,
  });

  const { data: dashboards } = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => configService.getDashboards(),
    staleTime: 300_000,
  });
  const phoenixUrl = dashboards?.traces || '';

  const handleSelect    = useCallback((item: SelectedItem) => setSelected(item), []);
  const handleSelectHop = useCallback((hop: Hop) => setSelected({ kind: 'hop', hop }), []);
  const handleClose     = useCallback(() => setSelected(null), []);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <Button variant="link" onClick={onBack}>← Back to runs</Button>
        <Title headingLevel="h4" size="md">
          {run.username ?? run.principal_id} · {run.hop_count} hop{run.hop_count !== 1 ? 's' : ''} · {new Date(run.started_at).toLocaleString()}
        </Title>
      </div>

      <HopLegend />

      <Tabs
        activeKey={activeView}
        onSelect={(_e, k) => { setActiveView(Number(k)); setSelected(null); }}
        style={{ marginTop: 8 }}
      >
        <Tab eventKey={0} title={<TabTitleText>Graph</TabTitleText>} />
        <Tab eventKey={1} title={<TabTitleText>Sequence</TabTitleText>} />
        <Tab eventKey={2} title={<TabTitleText>Hop Log</TabTitleText>} />
      </Tabs>

      {isLoading && <Spinner style={{ marginTop: 20 }} />}
      {isError   && <Alert variant="danger" title={String((error as Error)?.message ?? 'Error')} />}
      {hops && hops.length === 0 && <Alert variant="info" title="No hops recorded for this run." />}

      {hops && hops.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginTop: 8, height: 'calc(100vh - 320px)', minHeight: 460 }}>
          <div style={{ flex: 1, border: '1px solid #2a2a3e', borderRadius: 6, minWidth: 0, overflow: 'hidden' }}>
            {activeView === 0 && <GraphView    hops={hops} onSelect={handleSelect} />}
            {activeView === 1 && <SequenceView hops={hops} onSelect={handleSelect} />}
            {activeView === 2 && (
              <div style={{ overflowY: 'auto', height: '100%' }}>
                <HopLog hops={hops} onSelect={handleSelect} />
              </div>
            )}
          </div>
          {selected && (
            <DetailPanel item={selected} onClose={handleClose} onSelectHop={handleSelectHop} traceId={run.trace_id} phoenixUrl={phoenixUrl} />
          )}
        </div>
      )}
    </div>
  );
};
