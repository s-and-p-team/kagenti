// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0
//
// Lineage UI service. Calls the kagenti backend's /api/v1/lineage/* proxy,
// which (repointed) forwards to the data-governance pod's lineage contract.
// Follows the same apiFetch pattern as src/services/api.ts.

import { apiFetch } from '../../services/api';
import type {
  CommonEdge,
  DataGraph,
  Hop,
  PrincipalAgents,
  PrincipalPath,
  Run,
  RunGraph,
  RunSequence,
  RunTree,
  TimeRange,
} from '../lineage/types';

function sinceParam(timeRange: TimeRange): string | undefined {
  if (timeRange === 'all') return undefined;
  const ms = { '1h': 3600_000, '24h': 86400_000, '7d': 604800_000 }[timeRange];
  return new Date(Date.now() - ms).toISOString();
}

export const lineageService = {
  listRuns(params: {
    principal?: string;
    username?: string;
    agent?: string;
    tool?: string;
    timeRange?: TimeRange;
    limit?: number;
  } = {}): Promise<Run[]> {
    const q = new URLSearchParams();
    if (params.principal) q.set('principal', params.principal);
    if (params.username) q.set('username', params.username);
    if (params.agent) q.set('agent', params.agent);
    if (params.tool) q.set('tool', params.tool);
    if (params.timeRange) {
      const since = sinceParam(params.timeRange);
      if (since) q.set('since', since);
    }
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return apiFetch<Run[]>(`/lineage/runs${qs ? `?${qs}` : ''}`);
  },

  getTrajectory(runId: string): Promise<Hop[]> {
    return apiFetch<Hop[]>(`/lineage/runs/${encodeURIComponent(runId)}/trajectory`);
  },

  getRunGraph(runId: string): Promise<RunGraph> {
    return apiFetch<RunGraph>(`/lineage/runs/${encodeURIComponent(runId)}/graph`);
  },

  getRunSequence(runId: string): Promise<RunSequence> {
    return apiFetch<RunSequence>(`/lineage/runs/${encodeURIComponent(runId)}/sequence`);
  },

  getRunTree(runId: string): Promise<RunTree> {
    return apiFetch<RunTree>(`/lineage/runs/${encodeURIComponent(runId)}/tree`);
  },

  getDataGraph(): Promise<DataGraph> {
    return apiFetch<DataGraph>(`/lineage/datagraph`);
  },

  getPrincipalAgents(principalId: string): Promise<PrincipalAgents> {
    return apiFetch<PrincipalAgents>(`/lineage/principals/${encodeURIComponent(principalId)}/agents`);
  },

  getCommonEdges(params: { hopKind?: string; limit?: number } = {}): Promise<CommonEdge[]> {
    const q = new URLSearchParams();
    if (params.hopKind) q.set('hop_kind', params.hopKind);
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return apiFetch<CommonEdge[]>(`/lineage/edges/common${qs ? `?${qs}` : ''}`);
  },

  getPaths(agent: string, tool: string): Promise<PrincipalPath[]> {
    const q = new URLSearchParams({ agent, tool });
    return apiFetch<PrincipalPath[]>(`/lineage/paths?${q}`);
  },

  autocompleteAgents(prefix?: string): Promise<string[]> {
    const q = new URLSearchParams();
    if (prefix) q.set('prefix', prefix);
    q.set('limit', '30');
    return apiFetch<string[]>(`/lineage/autocomplete/agents?${q}`);
  },

  autocompleteTools(prefix?: string): Promise<string[]> {
    const q = new URLSearchParams();
    if (prefix) q.set('prefix', prefix);
    q.set('limit', '30');
    return apiFetch<string[]>(`/lineage/autocomplete/tools?${q}`);
  },
};
