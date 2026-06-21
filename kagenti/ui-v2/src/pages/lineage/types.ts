// TypeScript types for the Kagenti Data Lineage UI.
// Mirror the Pydantic response models in data_lineage/lineage_service/src/lineage_service/schema.py

export interface Run {
  run_id: string;
  trace_id: string;
  principal_id: string;
  username: string | null;
  started_at: string;   // ISO-8601
  ended_at: string | null;
  hop_count: number;
}

export interface Hop {
  hop_id: string;
  run_id: string;
  span_id: string;
  parent_span_id: string | null;
  source_id: string | null;
  target_id: string;
  hop_kind: 'principal_to_agent' | 'agent_to_agent' | 'agent_to_tool' | 'agent_to_llm';
  started_at: string;
  duration_ms: number | null;
  attrs: Record<string, unknown>;
}

export interface CommonEdge {
  source_id: string;
  target_id: string;
  total_count: number;
  principal_count: number;
  first_seen: string;
  last_seen: string;
}

export interface PrincipalPath {
  principal_id: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

export interface PrincipalAgents {
  principal_id: string;
  agents: string[];
}

// Per-run view models. DG derives these from its materialized edges/entities
// (+ spans join-back for content per ADR-0006); the UI only renders them.
export interface GraphNode {
  id: string;
  label: string;
  kind: string; // AGENT | LLM | TOOL | SERVICE | PRINCIPAL
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  count: number;
}

export interface RunGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SequenceMessage {
  seq: number;
  from: string;
  to: string;
  hop_kind: string;
  label: string;
  duration_ms: number | null;
  started_at: string;
}

export interface RunSequence {
  participants: string[];
  messages: SequenceMessage[];
}

// Tree View (execution forest) model — DG-derived from the run's hops.
export interface TreeChild {
  id: string;
  role: 'L' | 'tool';
  label: string;
  target: string;
  detail: string;
}
export interface TreeStore {
  id: string;
  label: string;
  kind: string;
}
export interface TreeLink {
  child: string;
  store: string;
  op: string;
}
export interface RunTree {
  user: { id: string; label: string } | null;
  agent: { id: string; label: string } | null;
  children: TreeChild[];
  stores: TreeStore[];
  links: TreeLink[];
}

// Data Graph (the mocked lineage view, ADR-0012) — served by DG, identical per run.
export interface DataGraphNode {
  id: string;
  label: string;
  type: string;
  verdict: 'clean' | 'confidential' | 'mixed';
  sub?: string;
  leak?: boolean;
  why?: string;
}
export interface DataGraphEdge {
  from: string;
  to: string;
  data?: string;
  verdict: string;
  fork?: boolean;
  leak?: boolean;
}
export interface DataGraph {
  mocked: boolean;
  title: string;
  boundaryAfter: number;
  boundaryLabel: string;
  nodes: DataGraphNode[];
  edges: DataGraphEdge[];
  legend: { cls: string; label: string }[];
  notes: string[];
}

export type TimeRange = '1h' | '24h' | '7d' | 'all';

export interface LineageFilters {
  principal: string;
  username: string;
  agent: string;
  tool: string;
  timeRange: TimeRange;
}
