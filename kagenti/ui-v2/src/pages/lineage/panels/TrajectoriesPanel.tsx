// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0

import React, { useState } from 'react';
import {
  EmptyState,
  EmptyStateHeader,
  EmptyStateIcon,
  EmptyStateBody,
  Spinner,
  Alert,
} from '@patternfly/react-core';
import {
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
} from '@patternfly/react-table';
import { ListIcon } from '@patternfly/react-icons';
import { useQuery } from '@tanstack/react-query';

import { lineageService } from '../../../services/lineageService';
import { TrajectoryDetail } from './TrajectoryDetail';
import type { LineageFilters, Run } from '../types';

interface Props {
  filters: LineageFilters;
}

export const TrajectoriesPanel: React.FC<Props> = ({ filters }) => {
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-runs', filters.principal, filters.agent, filters.tool, filters.timeRange],
    queryFn: () =>
      lineageService.listRuns({
        username: filters.principal || undefined,
        agent: filters.agent || undefined,
        tool: filters.tool || undefined,
        timeRange: filters.timeRange,
        limit: 100,
      }),
    staleTime: 30_000,
  });

  if (selectedRun) {
    return (
      <TrajectoryDetail
        run={selectedRun}
        onBack={() => setSelectedRun(null)}
      />
    );
  }

  if (isLoading) return <Spinner />;
  if (isError)
    return <Alert variant="danger" title={String((error as Error)?.message ?? 'Error loading runs')} />;

  if (!data || data.length === 0) {
    return (
      <EmptyState>
        <EmptyStateHeader
          titleText="No runs found"
          headingLevel="h4"
          icon={<EmptyStateIcon icon={ListIcon} />}
        />
        <EmptyStateBody>
          {filters.principal
            ? `No runs found for principal "${filters.principal}" in the selected time range.`
            : 'No runs recorded yet. Try a different time range or trigger an agent chain.'}
        </EmptyStateBody>
      </EmptyState>
    );
  }

  return (
    <Table aria-label="Runs" variant="compact">
      <Thead>
        <Tr>
          <Th>Principal</Th>
          <Th>Started</Th>
          <Th>Hops</Th>
          <Th>Trace ID</Th>
        </Tr>
      </Thead>
      <Tbody>
        {data.map((run) => (
          <Tr
            key={run.run_id}
            isClickable
            onRowClick={() => setSelectedRun(run)}
          >
            <Td>{run.username ?? run.principal_id}</Td>
            <Td>{new Date(run.started_at).toLocaleString()}</Td>
            <Td>{run.hop_count}</Td>
            <Td>
              <code style={{ fontSize: '0.75em' }}>{run.trace_id.slice(0, 16)}…</code>
            </Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
};
