// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0
//
// Trajectory detail: per-run views over DG-derived models. The data-governance
// pod owns ALL processing (entity graph, ordered sequence, hop rows, forest
// tree, data graph); this component only *renders* — Mermaid for the diagrams
// (dark, DG-pod palette), a table for the hop log, and a Drawer detail panel
// that shows the captured message body (wire bodies / LLM conversation) for a
// selected hop, mirroring the DG-pod forest view's node-detail panel.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  DrawerActions,
  DrawerCloseButton,
  DrawerContent,
  DrawerContentBody,
  DrawerHead,
  DrawerPanelContent,
  ExpandableSection,
  Label,
  Spinner,
  Tab,
  Tabs,
  TabTitleText,
  Title,
  ToggleGroup,
  ToggleGroupItem,
} from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import mermaid from 'mermaid';
import { useQuery } from '@tanstack/react-query';

import { lineageService } from '../../services/lineageService';
import type { DataGraph, Hop, Run, RunGraph, RunSequence, RunTree } from '../types';

// Light theme to fit the (light) kagenti UI; classDefs below set node colours.
mermaid.initialize({ startOnLoad: false, theme: 'default' });

type PfColor = 'blue' | 'cyan' | 'green' | 'orange' | 'purple' | 'red' | 'grey' | 'gold';

// Node colours are by TYPE only (never red/green — those are reserved for
// data-graph edge classification). Soft pastel fill + accent stroke; dark text.
const FLOW_CLASSDEFS = [
  '  classDef user fill:#F3EEFF,stroke:#8A63D2,stroke-width:2px;',
  '  classDef agent fill:#E7F1FF,stroke:#2980B9,stroke-width:2px;',
  '  classDef llm fill:#FFF6E5,stroke:#C98A00,stroke-width:2px;',
  '  classDef tool fill:#E6F7FB,stroke:#0E8FA8,stroke-width:2px;',
  '  classDef datastore fill:#FFF3E6,stroke:#D9822B,stroke-width:2px;',
  '  classDef store fill:#FFF3E6,stroke:#D9822B,stroke-width:2px,stroke-dasharray:4 3;',
  '  classDef external fill:#EEF1F4,stroke:#64748B,stroke-width:2px;',
];

// Shared flowchart init — softer fonts, smooth curved edges, roomier spacing,
// white edge-label chips, subtle cluster backgrounds. Prepended to every
// flowchart so Entities / Tree / Data Graph share one polished look.
const FLOW_INIT =
  "%%{init: {'theme':'base','themeVariables':{" +
  "'fontFamily':'-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif'," +
  "'fontSize':'13px','lineColor':'#94a3b8','edgeLabelBackground':'#ffffff'," +
  "'clusterBkg':'#fafbfc','clusterBorder':'#e2e8f0','primaryTextColor':'#1f2937'}," +
  "'flowchart':{'curve':'basis','nodeSpacing':48,'rankSpacing':78,'padding':10,'htmlLabels':true}}}%%";

// ── Shared Mermaid renderer (dark canvas, like the DG-pod view) ───────────────
let mermaidCounter = 0;
const MermaidView: React.FC<{ chart: string }> = ({ chart }) => {
  const ref = useRef<HTMLDivElement>(null);
  const render = useCallback(async () => {
    if (!ref.current || !chart) return;
    try {
      const { svg } = await mermaid.render(`lineage-mmd-${++mermaidCounter}`, chart);
      if (ref.current) ref.current.innerHTML = svg;
    } catch {
      if (ref.current) ref.current.textContent = 'Failed to render diagram';
    }
  }, [chart]);
  useEffect(() => {
    render();
  }, [render]);
  return (
    <div
      ref={ref}
      style={{
        background: '#fff',
        border: '1px solid #e8e8e8',
        borderRadius: 10,
        padding: '18px 14px',
        overflowX: 'auto',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        display: 'flex',
        justifyContent: 'center',
      }}
    />
  );
};

const KIND_CLASS: Record<string, string> = {
  AGENT: 'agent',
  LLM: 'llm',
  TOOL: 'tool',
  SERVICE: 'external',
  PRINCIPAL: 'user',
  DATASTORE: 'datastore',
};
// Data-graph node type → type class (never verdict; verdict shows only on edges).
const DG_TYPE_CLASS: Record<string, string> = {
  datastore: 'datastore',
  agent: 'agent',
  transform: 'llm',
  file: 'datastore',
  external: 'external',
};
// Type → hex (for the Hop Log kind chip, keeps tool = pink consistent).
const KIND_HEX: Record<string, string> = {
  agent_to_llm: '#C98A00',
  agent_to_tool: '#0E8FA8',
  agent_to_agent: '#2980B9',
  principal_to_agent: '#8A63D2',
  agent_to_service: '#64748B',
};

// ── Entities tab ──────────────────────────────────────────────────────────────
function toFlowchart(graph: RunGraph): string {
  const id = new Map<string, string>();
  graph.nodes.forEach((n, i) => id.set(n.id, `n${i}`));
  const lines = [FLOW_INIT, 'flowchart LR', ...FLOW_CLASSDEFS];
  graph.nodes.forEach((n) => {
    const label = `${n.label}<br/>${n.kind}`.replace(/"/g, '');
    lines.push(`  ${id.get(n.id)}["${label}"]:::${KIND_CLASS[n.kind] ?? 'service'}`);
  });
  graph.edges.forEach((e) => {
    const lbl = (e.count > 1 ? `${e.kind} ×${e.count}` : e.kind).replace(/\|/g, ' ');
    lines.push(`  ${id.get(e.source)} -->|${lbl}| ${id.get(e.target)}`);
  });
  return lines.join('\n');
}

const EntitiesTab: React.FC<{ runId: string }> = ({ runId }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-graph', runId],
    queryFn: () => lineageService.getRunGraph(runId),
    staleTime: 30_000,
  });
  const chart = useMemo(() => (data && data.nodes.length ? toFlowchart(data) : ''), [data]);
  if (isLoading) return <Spinner />;
  if (isError) return <Alert variant="danger" title={String((error as Error)?.message ?? 'Error')} />;
  if (!chart) return <Alert variant="info" title="No entities for this run." />;
  return <MermaidView chart={chart} />;
};

// ── Sequence tab — dark, colour-banded by hop kind ────────────────────────────
const KIND_RECT: Record<string, string> = {
  agent_to_llm: '255, 246, 229', // soft gold
  agent_to_tool: '224, 245, 250', // soft teal
  agent_to_agent: '231, 241, 255', // soft blue
  principal_to_agent: '243, 238, 255', // soft purple
  agent_to_service: '238, 241, 244', // soft slate
};
const SEQ_INIT =
  "%%{init: {'theme':'base','themeVariables':{" +
  "'fontFamily':'-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif','fontSize':'13px'," +
  "'actorBkg':'#ECECFF','actorBorder':'#9370DB','actorTextColor':'#1a1a2e'," +
  "'signalColor':'#555','signalTextColor':'#222','sequenceNumberColor':'#ffffff'}}}%%";

function toSequence(seq: RunSequence): string {
  const alias = new Map<string, string>();
  seq.participants.forEach((p, i) => alias.set(p, `p${i}`));
  const lines = [SEQ_INIT, 'sequenceDiagram', '    autonumber'];
  seq.participants.forEach((p) => lines.push(`    participant ${alias.get(p)} as ${p}`));
  seq.messages.forEach((m) => {
    const from = alias.get(m.from) ?? 'p0';
    const to = alias.get(m.to) ?? 'p0';
    const label = (m.label || m.hop_kind).replace(/->/g, '→').replace(/[:\n;]/g, ' ');
    lines.push(`    rect rgb(${KIND_RECT[m.hop_kind] ?? '40, 40, 50'})`);
    lines.push(`    ${from}->>${to}: ${label}`);
    lines.push('    end');
  });
  return lines.join('\n');
}

const SequenceTab: React.FC<{ runId: string }> = ({ runId }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-sequence', runId],
    queryFn: () => lineageService.getRunSequence(runId),
    staleTime: 30_000,
  });
  const chart = useMemo(() => (data && data.messages.length ? toSequence(data) : ''), [data]);
  if (isLoading) return <Spinner />;
  if (isError) return <Alert variant="danger" title={String((error as Error)?.message ?? 'Error')} />;
  if (!chart) return <Alert variant="info" title="No hops for this run." />;
  return <MermaidView chart={chart} />;
};

// ── Hop Log tab — clickable rows open the detail panel ────────────────────────
const HopLogTab: React.FC<{ runId: string; onSelect: (h: Hop) => void; selectedId?: string }> = ({
  runId,
  onSelect,
  selectedId,
}) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-trajectory', runId],
    queryFn: () => lineageService.getTrajectory(runId),
    staleTime: 30_000,
  });
  if (isLoading) return <Spinner />;
  if (isError) return <Alert variant="danger" title={String((error as Error)?.message ?? 'Error')} />;
  const hops: Hop[] = data ?? [];
  const mono = { fontFamily: 'var(--pf-v5-global--FontFamily--monospace, monospace)' };
  return (
    <Table variant="compact" isStriped aria-label="Hop log">
      <Thead>
        <Tr>
          <Th width={10}>#</Th>
          <Th>Kind</Th>
          <Th>Source</Th>
          <Th>Target</Th>
          <Th modifier="fitContent">Duration</Th>
          <Th modifier="fitContent">Status</Th>
        </Tr>
      </Thead>
      <Tbody>
        {hops.map((h, i) => {
          const status = (h.attrs as Record<string, unknown>)?.['http.status_code'];
          const statusNum = typeof status === 'number' ? status : Number(status);
          return (
            <Tr
              key={h.span_id}
              isClickable
              isRowSelected={selectedId === h.span_id}
              onRowClick={() => onSelect(h)}
            >
              <Td dataLabel="#">{i + 1}</Td>
              <Td dataLabel="Kind">
                {(() => {
                  const hex = KIND_HEX[h.hop_kind] ?? '#64748B';
                  return (
                    <span
                      style={{
                        color: hex,
                        border: `1px solid ${hex}`,
                        background: `${hex}14`,
                        borderRadius: 10,
                        padding: '0 8px',
                        fontSize: 11,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h.hop_kind}
                    </span>
                  );
                })()}
              </Td>
              <Td dataLabel="Source" style={mono}>{h.source_id ?? '—'}</Td>
              <Td dataLabel="Target" style={mono}>{h.target_id}</Td>
              <Td dataLabel="Duration" modifier="fitContent" style={{ textAlign: 'right', ...mono }}>
                {h.duration_ms != null ? `${h.duration_ms} ms` : '—'}
              </Td>
              <Td dataLabel="Status" modifier="fitContent">
                {status != null && status !== '' ? (
                  <Label isCompact color={statusNum && statusNum < 400 ? 'grey' : 'orange'}>
                    {String(status)}
                  </Label>
                ) : (
                  '—'
                )}
              </Td>
            </Tr>
          );
        })}
      </Tbody>
    </Table>
  );
};

// ── Tree View tab ─────────────────────────────────────────────────────────────
function toTree(tree: RunTree): string {
  if (!tree.agent) return '';
  const sid = new Map<string, string>();
  tree.stores.forEach((s, i) => sid.set(s.id, `s${i}`));
  const lines = [FLOW_INIT, 'flowchart LR', ...FLOW_CLASSDEFS];
  lines.push(`  U["${tree.user?.label ?? 'user'}"]:::user --> A["${tree.agent.label}"]:::agent`);
  tree.children.forEach((c) => {
    const cls = c.role === 'L' ? 'llm' : 'tool';
    const label = `${c.label}<br/>${c.detail}`.replace(/"/g, '');
    lines.push(`  A --> ${c.id}["${label}"]:::${cls}`);
  });
  tree.stores.forEach((s) => lines.push(`  ${sid.get(s.id)}["${s.label}"]:::store`));
  tree.links.forEach((l) => lines.push(`  ${l.child} -.${l.op}.-> ${sid.get(l.store)}`));
  return lines.join('\n');
}

const TreeTab: React.FC<{ runId: string }> = ({ runId }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-tree', runId],
    queryFn: () => lineageService.getRunTree(runId),
    staleTime: 30_000,
  });
  const chart = useMemo(() => (data && data.children.length ? toTree(data) : ''), [data]);
  if (isLoading) return <Spinner />;
  if (isError) return <Alert variant="danger" title={String((error as Error)?.message ?? 'Error')} />;
  if (!chart) return <Alert variant="info" title="No tree for this run." />;
  return <MermaidView chart={chart} />;
};

// ── Data Graph view (no "mocked" wording in the UI) ───────────────────────────
function toDataGraph(g: DataGraph): string {
  const zoneOf = (id: string): 's1' | 'fs' | 's2' =>
    ['D', 'A1', 'L'].includes(id) ? 's1' : ['F1', 'F2'].includes(id) ? 'fs' : 's2';
  const groups: Record<string, { title: string; ids: string[] }> = {
    s1: { title: 'Session 1 · T1', ids: [] },
    fs: { title: 'Persistent store', ids: [] },
    s2: { title: 'Session 2 · T2', ids: [] },
  };
  g.nodes.forEach((n) => groups[zoneOf(n.id)].ids.push(n.id));
  // Nodes coloured by TYPE only — never by verdict (classification is on edges).
  const decl = (id: string): string => {
    const n = g.nodes.find((x) => x.id === id)!;
    const label = n.label.replace(' · fresh trace', '').replace(/"/g, '');
    const sub = n.sub ? `<br/>${n.sub}` : '';
    return `${n.id}["${label}${sub}"]:::${DG_TYPE_CLASS[n.type] ?? 'external'}`;
  };
  const lines = [FLOW_INIT, 'flowchart LR', ...FLOW_CLASSDEFS];
  (['s1', 'fs', 's2'] as const).forEach((key) => {
    lines.push(`  subgraph ${key}["${groups[key].title}"]`);
    groups[key].ids.forEach((id) => lines.push(`    ${decl(id)}`));
    lines.push('  end');
  });
  // Edges carry the ONLY classification signal: red = d/d1/d3 (confidential
  // lineage), green = d2 (clean). Coloured via linkStyle by the data token.
  g.edges.forEach((e) => {
    const lbl = e.data ? `|${e.data}|` : '';
    lines.push(`  ${e.from} -->${lbl} ${e.to}`);
  });
  g.edges.forEach((e, i) => {
    const col = e.data === 'd2' ? '#1E9E54' : '#D64541';
    lines.push(`  linkStyle ${i} stroke:${col},stroke-width:2.5px;`);
  });
  return lines.join('\n');
}

const DataGraphView: React.FC = () => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-datagraph'],
    queryFn: () => lineageService.getDataGraph(),
    staleTime: 60_000,
  });
  const chart = useMemo(() => (data ? toDataGraph(data) : ''), [data]);
  if (isLoading) return <Spinner />;
  if (isError) return <Alert variant="danger" title={String((error as Error)?.message ?? 'Error')} />;
  if (!data) return <Alert variant="info" title="No data graph." />;
  return (
    <div>
      <Title headingLevel="h4" size="md" style={{ marginBottom: 10 }}>
        {data.title}
      </Title>
      <MermaidView chart={chart} />
    </div>
  );
};

// ── Detail panel — the message body for a selected hop (DG forest-view style) ──
function pretty(v: unknown): string {
  if (typeof v !== 'string') return JSON.stringify(v, null, 2);
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

interface ChatMessage {
  role: string;
  content: string;
  tools: string[];
}
function llmMessages(attrs: Record<string, unknown>, dir: 'input' | 'output'): ChatMessage[] {
  const prefix = `llm.${dir}_messages.`;
  const byIdx: Record<string, ChatMessage> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const idx = rest.split('.')[0];
    byIdx[idx] ??= { role: '', content: '', tools: [] };
    if (rest.endsWith('.message.role')) byIdx[idx].role = String(v);
    else if (rest.endsWith('.message.content')) byIdx[idx].content += String(v);
    else if (rest.includes('.message_content.text')) byIdx[idx].content += String(v);
    else if (rest.includes('.tool_calls.') && rest.endsWith('.function.name'))
      byIdx[idx].tools.push(String(v));
  }
  return Object.keys(byIdx)
    .sort((a, b) => Number(a) - Number(b))
    .map((i) => byIdx[i]);
}

const preStyle: React.CSSProperties = {
  background: '#f6f8fa',
  color: '#24292f',
  border: '1px solid #e0e0e0',
  borderRadius: 6,
  padding: 10,
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 300,
  overflow: 'auto',
};
const roleColor: Record<string, PfColor> = { system: 'grey', user: 'blue', assistant: 'purple', tool: 'gold' };

const HopDetailPanel: React.FC<{ hop: Hop; onClose: () => void }> = ({ hop, onClose }) => {
  const a = hop.attrs as Record<string, unknown>;
  const isLLM = hop.hop_kind === 'agent_to_llm';
  const inputMsgs = isLLM ? llmMessages(a, 'input') : [];
  const outputMsgs = isLLM ? llmMessages(a, 'output') : [];
  const status = a['http.status_code'];
  return (
    <DrawerPanelContent widths={{ default: 'width_50' }}>
      <DrawerHead>
        <Title headingLevel="h3" size="md">
          {hop.source_id ?? '—'} → {hop.target_id}
        </Title>
        <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
          {hop.hop_kind}
          {hop.duration_ms != null ? ` · ${hop.duration_ms} ms` : ''}
          {status != null ? ` · HTTP ${String(status)}` : ''}
        </div>
        <DrawerActions>
          <DrawerCloseButton onClick={onClose} />
        </DrawerActions>
      </DrawerHead>
      <div style={{ padding: '0 16px 16px' }}>
        {isLLM ? (
          <>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
              {String(a['llm.model_name'] ?? '')} · {String(a['llm.token_count.prompt'] ?? '?')}→
              {String(a['llm.token_count.completion'] ?? '?')} tok
            </div>
            {[...inputMsgs, ...outputMsgs].map((m, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <Label isCompact color={roleColor[m.role] ?? 'grey'}>{m.role || 'message'}</Label>
                {m.tools.length > 0 && (
                  <span style={{ fontSize: 12, color: '#888', marginLeft: 6 }}>↳ {m.tools.join(', ')}</span>
                )}
                {m.content && <pre style={preStyle}>{m.content}</pre>}
              </div>
            ))}
            {inputMsgs.length === 0 && outputMsgs.length === 0 && (
              <Alert variant="info" isInline isPlain title="No conversation captured on this span." />
            )}
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, margin: '4px 0', fontSize: 13 }}>Request</div>
            <pre style={preStyle}>{a['input.value'] != null ? pretty(a['input.value']) : '(none)'}</pre>
            <div style={{ fontWeight: 600, margin: '10px 0 4px', fontSize: 13 }}>Response</div>
            <pre style={preStyle}>{a['output.value'] != null ? pretty(a['output.value']) : '(none)'}</pre>
          </>
        )}
        <ExpandableSection toggleText="Raw attributes" style={{ marginTop: 10 }}>
          <pre style={preStyle}>{JSON.stringify(a, null, 2)}</pre>
        </ExpandableSection>
      </div>
    </DrawerPanelContent>
  );
};

interface Props {
  run: Run;
  onBack: () => void;
}

export const TrajectoryDetail: React.FC<Props> = ({ run, onBack }) => {
  const [view, setView] = useState<'flow' | 'datagraph'>('flow');
  const [active, setActive] = useState<number>(0);
  const [selected, setSelected] = useState<Hop | null>(null);

  const panel = selected ? <HopDetailPanel hop={selected} onClose={() => setSelected(null)} /> : null;

  return (
    <Drawer isExpanded={!!selected} isInline position="right">
      <DrawerContent panelContent={panel}>
        <DrawerContentBody>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <Button variant="link" onClick={onBack}>← Back to runs</Button>
            <Title headingLevel="h4" size="md">
              {run.principal_id} · {run.hop_count} hops · {new Date(run.started_at).toLocaleString()}
            </Title>
          </div>

          {/* Primary view switch — mirrors the DG-pod Execution forest ↔ Data graph toggle. */}
          <ToggleGroup aria-label="Execution Flow or Data Graph" style={{ marginBottom: 16 }}>
            <ToggleGroupItem text="Execution Flow" buttonId="view-flow" isSelected={view === 'flow'} onChange={() => setView('flow')} />
            <ToggleGroupItem text="Data Graph" buttonId="view-datagraph" isSelected={view === 'datagraph'} onChange={() => setView('datagraph')} />
          </ToggleGroup>

          {view === 'flow' ? (
            <Tabs activeKey={active} onSelect={(_e, k) => setActive(Number(k))} aria-label="Execution Flow views">
              <Tab eventKey={0} title={<TabTitleText>Entities</TabTitleText>}>
                <div style={{ marginTop: 16 }}><EntitiesTab runId={run.run_id} /></div>
              </Tab>
              <Tab eventKey={1} title={<TabTitleText>Sequence Diagram</TabTitleText>}>
                <div style={{ marginTop: 16 }}><SequenceTab runId={run.run_id} /></div>
              </Tab>
              <Tab eventKey={2} title={<TabTitleText>Hop Log</TabTitleText>}>
                <div style={{ marginTop: 16 }}>
                  <HopLogTab runId={run.run_id} onSelect={setSelected} selectedId={selected?.span_id} />
                  <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
                    Click a row to see the captured message body.
                  </div>
                </div>
              </Tab>
              <Tab eventKey={3} title={<TabTitleText>Tree View</TabTitleText>}>
                <div style={{ marginTop: 16 }}><TreeTab runId={run.run_id} /></div>
              </Tab>
            </Tabs>
          ) : (
            <div style={{ marginTop: 8 }}><DataGraphView /></div>
          )}
        </DrawerContentBody>
      </DrawerContent>
    </Drawer>
  );
};
