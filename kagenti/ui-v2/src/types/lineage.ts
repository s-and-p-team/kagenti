// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0

// TypeScript types for the Kagenti Data Lineage UI.
// Mirror the Pydantic response models in data_lineage/lineage_service/src/lineage_service/schema.py

export interface Run {
  run_id: string;
  trace_id: string;
  principal_id: string;
  username: string | null;
  started_at: string;
  ended_at: string | null;
  hop_count: number;
}

export interface Hop {
  hop_id: string;
  run_id: string;
  span_id: string;
  parent_span_id: string | null;
  caller_id: string | null;
  target_id: string;
  hop_kind: 'principal_to_agent' | 'agent_to_agent' | 'agent_to_tool' | 'agent_to_llm';
  started_at: string;
  duration_ms: number | null;
  attrs: Record<string, unknown>;
}

export interface CommonEdge {
  caller_id: string;
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

export type TimeRange = '1h' | '24h' | '7d' | 'all';

export interface LineageFilters {
  username: string;
  agent: string;
  tool: string;
  timeRange: TimeRange;
}
