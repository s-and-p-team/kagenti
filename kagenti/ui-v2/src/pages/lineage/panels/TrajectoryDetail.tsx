// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0

import React, { useMemo } from 'react';
import {
  Button,
  Spinner,
  Alert,
  Title,
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
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';
import { useQuery } from '@tanstack/react-query';

import { lineageService } from '../../../services/lineageService';
import type { Hop, Run } from '../types';

const HOP_COLORS: Record<string, string> = {
  principal_to_agent: '#9c59b6',
  agent_to_agent:     '#2980b9',
  agent_to_tool:      '#27ae60',
  agent_to_llm:       '#e67e22',
};

const NODE_WIDTH  = 180;
const NODE_HEIGHT = 60;

function buildGraph(hops: Hop[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 100 });

  const nodeIds = new Set<string>();
  for (const hop of hops) {
    if (hop.caller_id) nodeIds.add(hop.caller_id);
    nodeIds.add(hop.target_id);
  }

  nodeIds.forEach((id) => {
    g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  const flowEdges: Edge[] = hops.map((hop, i) => {
    const source = hop.caller_id ?? '__principal__';
    const target = hop.target_id;
    if (hop.caller_id) g.setEdge(source, target);
    return {
      id: `hop-${i}`,
      source,
      target,
      label: `${hop.hop_kind}${hop.duration_ms != null ? ` · ${hop.duration_ms}ms` : ''}`,
      style: { stroke: HOP_COLORS[hop.hop_kind] ?? '#888' },
      labelStyle: { fontSize: 10 },
    };
  });

  dagre.layout(g);

  const flowNodes: Node[] = Array.from(nodeIds).map((id) => {
    const pos = g.node(id);
    return {
      id,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: { label: id },
      style: {
        background: '#1a1a2e',
        color: '#e0e0e0',
        border: '1px solid #444',
        borderRadius: 6,
        padding: '6px 12px',
        fontSize: 12,
        width: NODE_WIDTH,
        textAlign: 'center',
      },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

function ServiceNode({ data }: { data: { label: string } }) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div style={{ padding: '4px 8px' }}>{data.label}</div>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

const nodeTypes = { default: ServiceNode };

interface Props {
  run: Run;
  onBack: () => void;
}

export const TrajectoryDetail: React.FC<Props> = ({ run, onBack }) => {
  const { data: hops, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-trajectory', run.run_id],
    queryFn: () => lineageService.getTrajectory(run.run_id),
    staleTime: 30_000,
  });

  const { nodes, edges } = useMemo(
    () => (hops && hops.length > 0 ? buildGraph(hops) : { nodes: [], edges: [] }),
    [hops]
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Button variant="link" onClick={onBack}>← Back to runs</Button>
        <Title headingLevel="h4" size="md">
          {run.principal_id} · {run.hop_count} hops · {new Date(run.started_at).toLocaleString()}
        </Title>
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 12 }}>
        {Object.entries(HOP_COLORS).map(([kind, color]) => (
          <span key={kind} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: color, display: 'inline-block' }} />
            {kind}
          </span>
        ))}
      </div>

      {isLoading && <Spinner />}
      {isError && <Alert variant="danger" title={String((error as Error)?.message ?? 'Error')} />}
      {hops && hops.length === 0 && (
        <Alert variant="info" title="No hops recorded for this run." />
      )}

      {nodes.length > 0 && (
        <div style={{ height: 420, border: '1px solid #333', borderRadius: 6 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            attributionPosition="bottom-right"
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      )}
    </div>
  );
};
