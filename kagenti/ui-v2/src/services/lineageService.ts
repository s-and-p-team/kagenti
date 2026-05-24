// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0

import { apiFetch } from './api';
import type { CommonEdge, Hop, PrincipalAgents, PrincipalPath, Run, TimeRange } from '../pages/lineage/types';

function sinceParam(timeRange: TimeRange): string | undefined {
  if (timeRange === 'all') return undefined;
  const ms: Record<string, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };
  return new Date(Date.now() - ms[timeRange]).toISOString();
}

export const lineageService = {
  listRuns(params: {
    username?: string;
    agent?: string;
    tool?: string;
    timeRange?: TimeRange;
    limit?: number;
  } = {}): Promise<Run[]> {
    const q = new URLSearchParams();
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
    const q = new URLSearchParams({ limit: '30' });
    if (prefix) q.set('prefix', prefix);
    return apiFetch<string[]>(`/lineage/autocomplete/agents?${q}`);
  },

  autocompleteTools(prefix?: string): Promise<string[]> {
    const q = new URLSearchParams({ limit: '30' });
    if (prefix) q.set('prefix', prefix);
    return apiFetch<string[]>(`/lineage/autocomplete/tools?${q}`);
  },
};
