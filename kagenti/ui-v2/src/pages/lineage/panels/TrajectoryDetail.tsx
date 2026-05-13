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
import type { Hop, Run } from '@/types/lineage';

// ─── Color constants ────────────────────────────────────────────────────────

const HOP_COLORS: Record<string, string> = {
  principal_to_agent: '#9c59b6',
  agent_to_agent:     '#2980b9',
  agent_to_tool:      '#27ae60',
  agent_to_llm:       '#e67e22',
};

// Hops with unrecognised hop_kind (e.g. empty string from raw OpenTelemetry spans
// that pre-date the trust stamping step) are excluded from graph and sequence views.
const KNOWN_KINDS = new Set(Object.keys(HOP_COLORS));

const NODE_BG: Record<string, string> = {
  source: '#4a235a',
  agent:  '#1a3a5c',
  llm:    '#7e5109',
  tool:   '#1e5631',
};

const NODE_LABEL: Record<string, string> = {
  source: 'source',
  agent:  'agent',
  llm:    'llm',
  tool:   'tool',
};

// ─── Column layout ──────────────────────────────────────────────────────────
// LLM and tool share the same x column so all agent→{llm,tool} edges fan out
// cleanly without passing through each other's nodes.

const COL_X: Record<string, number> = {
  source: 80,
  agent:  300,
  llm:    520,
  tool:   520,
};
const NODE_W = 160;
const NODE_H = 48;
const VERT_GAP = 76;

// ─── Node classification ─────────────────────────────────────────────────────

function classifyNodes(hops: Hop[]): Map<string, 'source' | 'agent' | 'llm' | 'tool'> {
  const isTarget    = new Set<string>();
  const isLLMTarget = new Set<string>();
  const isToolTarget = new Set<string>();
  for (const h of hops) {
    isTarget.add(h.target_id);
    if (h.hop_kind === 'agent_to_llm')  isLLMTarget.add(h.target_id);
    if (h.hop_kind === 'agent_to_tool') isToolTarget.add(h.target_id);
  }
  const all = new Set<string>();
  for (const h of hops) { if (h.caller_id) all.add(h.caller_id); all.add(h.target_id); }

  const result = new Map<string, 'source' | 'agent' | 'llm' | 'tool'>();
  for (const id of all) {
    if (isLLMTarget.has(id))       result.set(id, 'llm');
    else if (isToolTarget.has(id)) result.set(id, 'tool');
    else if (!isTarget.has(id))    result.set(id, 'source');
    else                           result.set(id, 'agent');
  }
  return result;
}

// Build hop index: nodeId → hops involving it
function buildHopIndex(hops: Hop[]): Map<string, Hop[]> {
  const idx = new Map<string, Hop[]>();
  const add = (id: string, h: Hop) => {
    const arr = idx.get(id) ?? [];
    arr.push(h);
    idx.set(id, arr);
  };
  for (const h of hops) {
    if (h.caller_id) add(h.caller_id, h);
    add(h.target_id, h);
  }
  return idx;
}

// ─── ReactFlow graph builder ─────────────────────────────────────────────────

function buildGraph(hops: Hop[]): { nodes: Node[]; edges: Edge[] } {
  const nodeTypes = classifyNodes(hops);
  const hopIdx    = buildHopIndex(hops);
  const byCol: Record<string, string[]> = { source: [], agent: [], llm: [], tool: [] };
  for (const [id, t] of nodeTypes) byCol[t].push(id);

  // Step 1: Assign y to leaf nodes (llm + tool), stacked in one column.
  const nodeY = new Map<string, number>();
  let leafRow = 0;
  for (const col of ['llm', 'tool'] as const) {
    for (const id of byCol[col]) nodeY.set(id, leafRow++ * VERT_GAP);
  }

  // Step 2: Center each agent over the midpoint of its targets' y positions
  // so edges fan out symmetrically without passing through sibling nodes.
  for (const agentId of byCol['agent']) {
    const ys = hops
      .filter(h => h.caller_id === agentId)
      .map(h => nodeY.get(h.target_id))
      .filter((y): y is number => y !== undefined);
    nodeY.set(agentId, ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0);
  }

  // Step 3: Center each source over its agents (same logic, one level back).
  for (const srcId of byCol['source']) {
    const ys = hops
      .filter(h => h.caller_id === srcId)
      .map(h => nodeY.get(h.target_id))
      .filter((y): y is number => y !== undefined);
    nodeY.set(srcId, ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0);
  }

  const nodes: Node[] = [...nodeTypes.keys()].map(id => ({
    id,
    position: { x: COL_X[nodeTypes.get(id)!] - NODE_W / 2, y: nodeY.get(id) ?? 0 },
    data: { label: id, nodeType: nodeTypes.get(id)!, hops: hopIdx.get(id) ?? [] },
    type: 'serviceNode',
  }));

  // Deduplicate edges: one topology edge per unique (caller, target) pair.
  // Multiple hops to the same target (e.g. two LLM calls) collapse into one
  // edge with a ×N label so the graph shows structure, not call frequency.
  const edgeMap = new Map<string, { hop: Hop; count: number }>();
  for (const h of hops) {
    const key = `${h.caller_id ?? '__root__'}\0${h.target_id}`;
    const existing = edgeMap.get(key);
    if (!existing) edgeMap.set(key, { hop: h, count: 1 });
    else           existing.count++;
  }

  const edges: Edge[] = [...edgeMap.values()].map(({ hop, count }, i) => ({
    id:     `edge-${i}`,
    source:  hop.caller_id ?? '__root__',
    target:  hop.target_id,
    type:   'smoothstep',
    data: { hop },
    label:  count > 1 ? `×${count}` : undefined,
    labelStyle: { fill: '#aaa', fontSize: 11 },
    labelBgStyle: { fill: 'transparent' },
    style: { stroke: HOP_COLORS[hop.hop_kind] ?? '#888', strokeWidth: 3 },
  }));

  return { nodes, edges };
}

// ─── Custom ReactFlow node ────────────────────────────────────────────────────

function ServiceNode({ data }: { data: { label: string; nodeType: string } }) {
  return (
    <>
      <Handle type="target" position={Position.Left} style={{ background: '#888' }} />
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

// ─── Attribute groups for the detail panel ───────────────────────────────────

const ATTR_GROUPS: [string, string[]][] = [
  ['Identity',  ['openinference.span.kind', 'gen_ai.system', 'gen_ai.agent.name', 'llm.model_name', 'gen_ai.request.model', 'tool.name']],
  ['Input',     ['input.value', 'gen_ai.prompt', 'mlflow.spanInputs']],
  ['Output',    ['output.value', 'gen_ai.completion', 'mlflow.spanOutputs']],
  ['Tokens',    ['llm.token_count.prompt', 'llm.token_count.completion', 'llm.token_count.total', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens']],
  ['Trust',     ['trust.principal_id', 'trust.caller_id', 'trust.target_id', 'trust.hop_kind', 'gen_ai.conversation.id']],
];
const GROUPED_KEYS = new Set(ATTR_GROUPS.flatMap(([, ks]) => ks));

// ─── Hop detail panel ─────────────────────────────────────────────────────────

function HopDetailPanel({ hop, onClose }: { hop: Hop; onClose: () => void }) {
  const attrs = hop.attrs ?? {};
  return (
    <div style={{
      width: 380, flexShrink: 0, overflowY: 'auto',
      background: '#ffffff', border: '1px solid #d2d2d2',
      borderRadius: 8, padding: 16, fontSize: 13, color: '#222',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <span style={{
          background: HOP_COLORS[hop.hop_kind] ?? '#888',
          color: '#fff', fontSize: 11, padding: '3px 10px',
          borderRadius: 12, fontWeight: 600,
        }}>
          {hop.hop_kind}
        </span>
        <Button variant="plain" onClick={onClose} style={{ minWidth: 'auto', padding: '0 4px', color: '#555', fontSize: 16 }}>×</Button>
      </div>

      {/* Summary */}
      <dl style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: '4px 8px', marginBottom: 12, color: '#333' }}>
        <dt style={{ color: '#666', fontWeight: 500 }}>Caller</dt>  <dd style={{ margin: 0 }}>{hop.caller_id ?? '—'}</dd>
        <dt style={{ color: '#666', fontWeight: 500 }}>Target</dt>  <dd style={{ margin: 0 }}>{hop.target_id}</dd>
        <dt style={{ color: '#666', fontWeight: 500 }}>Started</dt> <dd style={{ margin: 0 }}>{new Date(hop.started_at).toLocaleString()}</dd>
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
              <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5, fontWeight: 600 }}>
                {group}
              </div>
              {present.map(k => (
                <div key={k} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 11, color: '#1976d2', marginBottom: 2 }}>{k}</div>
                  <div style={{
                    fontSize: 13, color: '#222',
                    wordBreak: 'break-all', whiteSpace: 'pre-wrap',
                    maxHeight: 160, overflowY: 'auto',
                    background: '#f4f4f4', padding: '4px 8px', borderRadius: 4,
                    border: '1px solid #e0e0e0',
                  }}>
                    {String(attrs[k]).length > 600 ? String(attrs[k]).slice(0, 600) + ' …' : String(attrs[k])}
                  </div>
                </div>
              ))}
            </div>
          );
        })}

        {/* Other attributes */}
        {(() => {
          const others = Object.entries(attrs).filter(([k]) => !GROUPED_KEYS.has(k));
          if (!others.length) return null;
          return (
            <div>
              <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5, fontWeight: 600 }}>
                Other
              </div>
              {others.map(([k, v]) => (
                <div key={k} style={{ fontSize: 12, color: '#444', marginBottom: 3 }}>
                  <span style={{ color: '#1976d2', marginRight: 6 }}>{k}</span>
                  {String(v).slice(0, 100)}
                </div>
              ))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ─── Node hops panel ──────────────────────────────────────────────────────────

function NodeHopsPanel({
  nodeId, nodeType, hops, onClose, onSelectHop,
}: { nodeId: string; nodeType: string; hops: Hop[]; onClose: () => void; onSelectHop: (h: Hop) => void }) {
  return (
    <div style={{
      width: 380, flexShrink: 0, overflowY: 'auto',
      background: '#ffffff', border: '1px solid #d2d2d2',
      borderRadius: 8, padding: 16, fontSize: 13, color: '#222',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            background: NODE_BG[nodeType] ?? '#555',
            color: '#fff', fontSize: 11, padding: '2px 8px', borderRadius: 10,
          }}>
            {nodeType}
          </span>
          <span style={{ color: '#111', fontWeight: 600 }}>{nodeId}</span>
        </div>
        <Button variant="plain" onClick={onClose} style={{ minWidth: 'auto', padding: '0 4px', color: '#555', fontSize: 16 }}>×</Button>
      </div>

      <div style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>
        {hops.length} span{hops.length !== 1 ? 's' : ''} — click to inspect
      </div>

      {hops.map((h, i) => (
        <div
          key={h.hop_id ?? i}
          onClick={() => onSelectHop(h)}
          style={{
            cursor: 'pointer', padding: 10, borderRadius: 6,
            border: '1px solid #e0e0e0', marginBottom: 8,
            background: '#fafafa',
            transition: 'border-color 0.1s, background 0.1s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#1976d2'; e.currentTarget.style.background = '#f0f7ff'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#e0e0e0'; e.currentTarget.style.background = '#fafafa'; }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: HOP_COLORS[h.hop_kind] ?? '#555', fontWeight: 600, fontSize: 12 }}>
              {h.hop_kind}
            </span>
            {h.duration_ms != null && (
              <span style={{ color: '#888', fontSize: 12 }}>{h.duration_ms} ms</span>
            )}
          </div>
          <div style={{ color: '#444', fontSize: 13 }}>{h.caller_id ?? '—'} → {h.target_id}</div>
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

// ─── Detail panel (union) ─────────────────────────────────────────────────────

type SelectedItem =
  | { kind: 'hop';  hop: Hop }
  | { kind: 'node'; nodeId: string; nodeType: string; hops: Hop[] };

function DetailPanel({ item, onClose, onSelectHop }: {
  item: SelectedItem; onClose: () => void; onSelectHop: (h: Hop) => void;
}) {
  if (item.kind === 'hop') {
    return <HopDetailPanel hop={item.hop} onClose={onClose} />;
  }
  return (
    <NodeHopsPanel
      nodeId={item.nodeId}
      nodeType={item.nodeType}
      hops={item.hops}
      onClose={onClose}
      onSelectHop={onSelectHop}
    />
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function HopLegend() {
  return (
    <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#888', alignItems: 'center' }}>
      {Object.entries(HOP_COLORS).map(([kind, color]) => (
        <span key={kind} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <svg width={28} height={6}>
            <line x1={0} y1={3} x2={28} y2={3} stroke={color} strokeWidth={3} />
          </svg>
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
    const hop = edge.data?.hop as Hop | undefined;
    if (hop) onSelect({ kind: 'hop', hop });
  }, [onSelect]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const { nodeType, hops: nodeHops } = node.data as { nodeType: string; hops: Hop[] };
    onSelect({ kind: 'node', nodeId: node.id, nodeType, hops: nodeHops });
  }, [onSelect]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onEdgeClick={handleEdgeClick}
      onNodeClick={handleNodeClick}
      fitView
      attributionPosition="bottom-right"
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

// ─── Sequence diagram ─────────────────────────────────────────────────────────

const SEQ = {
  padLeft:     20,
  boxW:        140,
  boxH:        36,
  boxTop:      10,
  colSpacing:  190,  // center-to-center
  lifelineTop: 50,   // height of the sticky header (boxes)
  evtH:        52,   // vertical space per event row (request OR response)
  arrowSize:   7,
};

function seqEntityX(i: number) {
  return SEQ.padLeft + SEQ.boxW / 2 + i * SEQ.colSpacing;
}

function Arrowhead({ x, y, toRight, color }: { x: number; y: number; toRight: boolean; color: string }) {
  const s = SEQ.arrowSize;
  if (toRight) {
    return <polygon points={`${x - s},${y - s / 2} ${x},${y} ${x - s},${y + s / 2}`} fill={color} />;
  }
  return <polygon points={`${x + s},${y - s / 2} ${x},${y} ${x + s},${y + s / 2}`} fill={color} />;
}

// Each hop is split into two events: a forward "request" and a return "response".
// Sorting all events by wall-clock time produces a correct sequence diagram where,
// for example, the outer agent's response appears AFTER all nested calls finish —
// not paired immediately with its request at the top.
type SeqEvent = { kind: 'request' | 'response'; hop: Hop; time: number };

function SequenceView({ hops, onSelect }: { hops: Hop[]; onSelect: (item: SelectedItem) => void }) {
  const [hoveredHop, setHoveredHop] = useState<string | null>(null);

  const knownHops = useMemo(() => hops.filter(h => KNOWN_KINDS.has(h.hop_kind)), [hops]);
  const nodeTypes = useMemo(() => classifyNodes(knownHops), [knownHops]);

  // Build ordered entity list: source → agent → llm → tool, then by first appearance
  const entities = useMemo(() => {
    const order: Record<string, number> = { source: 0, agent: 1, llm: 2, tool: 3 };
    const seen = new Map<string, number>(); // id → first-hop index
    knownHops.forEach((h, i) => {
      if (h.caller_id && !seen.has(h.caller_id)) seen.set(h.caller_id, i);
      if (!seen.has(h.target_id)) seen.set(h.target_id, i);
    });
    return [...seen.keys()].sort((a, b) => {
      const ta = nodeTypes.get(a) ?? 'agent';
      const tb = nodeTypes.get(b) ?? 'agent';
      return order[ta] !== order[tb]
        ? order[ta] - order[tb]
        : (seen.get(a) ?? 0) - (seen.get(b) ?? 0);
    });
  }, [knownHops, nodeTypes]);

  const entityX = useMemo(() => {
    const m = new Map<string, number>();
    entities.forEach((id, i) => m.set(id, seqEntityX(i)));
    return m;
  }, [entities]);

  // Split each hop into (request @ started_at) and (response @ started_at + duration_ms),
  // then sort all events chronologically so nested call responses appear after sub-calls finish.
  const events = useMemo((): SeqEvent[] => {
    const evts: SeqEvent[] = [];
    for (const h of knownHops) {
      const t = new Date(h.started_at).getTime();
      evts.push({ kind: 'request',  hop: h, time: t });
      evts.push({ kind: 'response', hop: h, time: t + (h.duration_ms ?? 0) });
    }
    return evts.sort((a, b) => a.time - b.time || (a.kind === 'request' ? -1 : 1));
  }, [knownHops]);

  const svgW  = SEQ.padLeft * 2 + entities.length * SEQ.colSpacing;
  const bodyH = events.length * SEQ.evtH + 20;

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>

      {/* ── Sticky header: entity boxes stay visible while scrolling down ── */}
      <svg
        width={svgW}
        height={SEQ.lifelineTop}
        style={{ display: 'block', position: 'sticky', top: 0, zIndex: 10, background: '#0f1117' }}
      >
        {entities.map((id, i) => {
          const cx = seqEntityX(i);
          const type = nodeTypes.get(id) ?? 'agent';
          return (
            <g key={id}>
              <rect
                x={cx - SEQ.boxW / 2} y={SEQ.boxTop}
                width={SEQ.boxW} height={SEQ.boxH}
                rx={5} fill={NODE_BG[type]} stroke="#444" strokeWidth={1}
              />
              <text
                x={cx} y={SEQ.boxTop + SEQ.boxH / 2}
                dominantBaseline="middle" textAnchor="middle"
                fill="#e0e0e0" fontSize={10} fontWeight="600"
              >
                {id.length > 18 ? id.slice(0, 17) + '…' : id}
              </text>
              <text
                x={cx} y={SEQ.boxTop + SEQ.boxH / 2 + 13}
                dominantBaseline="middle" textAnchor="middle"
                fill="#888" fontSize={8}
              >
                {type}
              </text>
              {/* Lifeline stub down to the bottom edge of the header */}
              <line
                x1={cx} y1={SEQ.boxTop + SEQ.boxH}
                x2={cx} y2={SEQ.lifelineTop}
                stroke="#333" strokeWidth={1} strokeDasharray="4,4"
              />
            </g>
          );
        })}
      </svg>

      {/* ── Scrollable body: lifelines + hop arrows ── */}
      <svg width={svgW} height={bodyH} style={{ display: 'block', fontFamily: 'monospace' }}>
        {/* Lifelines span the full body height */}
        {entities.map((id, i) => {
          const cx = seqEntityX(i);
          return (
            <line
              key={`ll-${id}`}
              x1={cx} y1={0} x2={cx} y2={bodyH - 20}
              stroke="#333" strokeWidth={1} strokeDasharray="4,4"
            />
          );
        })}

        {/* Events sorted by wall-clock time — each is either a forward request or a return response */}
        {events.map((evt, i) => {
          const { kind, hop: h } = evt;
          const isReq = kind === 'request';
          // Request: caller → target; Response: target → caller (reversed)
          const srcId = isReq ? (h.caller_id ?? '') : h.target_id;
          const dstId = isReq ? h.target_id : (h.caller_id ?? '');
          const cx = entityX.get(srcId) ?? (entities.length > 0 ? seqEntityX(0) : 0);
          const tx = entityX.get(dstId) ?? 0;
          const y   = i * SEQ.evtH + 16;
          const color = HOP_COLORS[h.hop_kind] ?? '#888';
          const toRight = cx <= tx;
          const isHovered = hoveredHop === h.hop_id;
          const midX = (cx + tx) / 2;
          const evtKey = `${h.hop_id ?? i}-${kind}`;

          return (
            <g
              key={evtKey}
              onClick={() => onSelect({ kind: 'hop', hop: h })}
              onMouseEnter={() => setHoveredHop(h.hop_id)}
              onMouseLeave={() => setHoveredHop(null)}
              style={{ cursor: 'pointer' }}
            >
              {isHovered && (
                <rect
                  x={Math.min(cx, tx) - 8} y={y - 14}
                  width={Math.abs(tx - cx) + 16} height={SEQ.evtH - 8}
                  rx={4} fill="rgba(255,255,255,0.05)" stroke="#2a3f6f" strokeWidth={1}
                />
              )}
              <line
                x1={cx} y1={y} x2={tx} y2={y}
                stroke={color}
                strokeWidth={isReq ? 2 : 1.5}
                strokeDasharray={isReq ? undefined : '5,3'}
                opacity={isReq ? 1 : 0.7}
              />
              <Arrowhead x={toRight ? tx : tx} y={y} toRight={toRight} color={color} />
              {isReq ? (
                <text x={midX} y={y - 6} textAnchor="middle" fill={color} fontSize={9} fontWeight="600">
                  {h.hop_kind.replace('agent_to_', '').replace('principal_to_', '→')}
                </text>
              ) : (
                h.duration_ms != null && (
                  <text x={midX} y={y - 6} textAnchor="middle" fill={color} fontSize={8} opacity={0.7}>
                    {h.duration_ms} ms
                  </text>
                )
              )}
            </g>
          );
        })}
      </svg>
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
  const [selected, setSelected] = useState<SelectedItem | null>(null);

  const { data: hops, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-trajectory', run.run_id],
    queryFn: () => lineageService.getTrajectory(run.run_id),
    staleTime: 30_000,
  });

  const handleSelect = useCallback((item: SelectedItem) => setSelected(item), []);
  const handleSelectHop = useCallback((hop: Hop) => setSelected({ kind: 'hop', hop }), []);
  const handleClose = useCallback(() => setSelected(null), []);

  // Full-height container minus the chrome above
  const containerH = 'calc(100vh - 320px)';
  const minH = 460;

  return (
    <div>
      {/* Back + run summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <Button variant="link" onClick={onBack}>← Back to runs</Button>
        <Title headingLevel="h4" size="md">
          {run.username ?? run.principal_id} · {run.hop_count} hop{run.hop_count !== 1 ? 's' : ''} · {new Date(run.started_at).toLocaleString()}
        </Title>
      </div>

      <HopLegend />

      {/* Sub-tabs: Graph | Sequence */}
      <Tabs
        activeKey={activeView}
        onSelect={(_e, k) => { setActiveView(Number(k)); setSelected(null); }}
        style={{ marginTop: 8 }}
      >
        <Tab eventKey={0} title={<TabTitleText>Graph</TabTitleText>} />
        <Tab eventKey={1} title={<TabTitleText>Sequence</TabTitleText>} />
      </Tabs>

      {isLoading && <Spinner style={{ marginTop: 20 }} />}
      {isError && <Alert variant="danger" title={String((error as Error)?.message ?? 'Error')} />}
      {hops && hops.length === 0 && <Alert variant="info" title="No hops recorded for this run." />}

      {hops && hops.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginTop: 8, height: containerH, minHeight: minH }}>
          {/* Main view */}
          <div style={{ flex: 1, border: '1px solid #2a2a3e', borderRadius: 6, minWidth: 0, overflow: 'hidden' }}>
            {activeView === 0 ? (
              <GraphView hops={hops} onSelect={handleSelect} />
            ) : (
              <SequenceView hops={hops} onSelect={handleSelect} />
            )}
          </div>

          {/* Detail panel */}
          {selected && (
            <DetailPanel
              item={selected}
              onClose={handleClose}
              onSelectHop={handleSelectHop}
            />
          )}
        </div>
      )}
    </div>
  );
};
