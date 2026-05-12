// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0
//
// Query 02: Top agent-to-agent delegation pairs aggregated across all principals.
// Filters to rows where caller_id or target_id matches the agent filter.

import React from 'react';
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
import { TopologyIcon } from '@patternfly/react-icons';
import { useQuery } from '@tanstack/react-query';

import { lineageService } from '@/services/lineageService';
import type { LineageFilters } from '@/types/lineage';

interface Props {
  filters: LineageFilters;
}

export const CommonEdgesPanel: React.FC<Props> = ({ filters }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-common-edges'],
    queryFn: () => lineageService.getCommonEdges({ hopKind: 'agent_to_agent', limit: 100 }),
    staleTime: 30_000,
  });

  const rows = (data ?? []).filter((e) => {
    if (!filters.agent) return true;
    const a = filters.agent.toLowerCase();
    return e.caller_id.toLowerCase().includes(a) || e.target_id.toLowerCase().includes(a);
  });

  if (isLoading) return <Spinner />;
  if (isError)
    return <Alert variant="danger" title={String((error as Error)?.message ?? 'Error loading edges')} />;

  if (rows.length === 0) {
    return (
      <EmptyState>
        <EmptyStateHeader
          titleText="No delegation pairs found"
          headingLevel="h4"
          icon={<EmptyStateIcon icon={TopologyIcon} />}
        />
        <EmptyStateBody>
          {filters.agent
            ? `No agent-to-agent edges involving "${filters.agent}".`
            : 'No agent-to-agent delegation recorded yet.'}
        </EmptyStateBody>
      </EmptyState>
    );
  }

  return (
    <Table aria-label="Common delegation edges" variant="compact">
      <Thead>
        <Tr>
          <Th>Caller</Th>
          <Th>Target</Th>
          <Th modifier="nowrap">Total calls</Th>
          <Th modifier="nowrap">Principals</Th>
          <Th>First seen</Th>
          <Th>Last seen</Th>
        </Tr>
      </Thead>
      <Tbody>
        {rows.map((e, i) => (
          <Tr key={i}>
            <Td>
              <code>{e.caller_id}</code>
            </Td>
            <Td>
              <code>{e.target_id}</code>
            </Td>
            <Td>
              <span style={{ fontWeight: 600 }}>{e.total_count}</span>
            </Td>
            <Td>{e.principal_count}</Td>
            <Td>{new Date(e.first_seen).toLocaleDateString()}</Td>
            <Td>{new Date(e.last_seen).toLocaleDateString()}</Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
};
