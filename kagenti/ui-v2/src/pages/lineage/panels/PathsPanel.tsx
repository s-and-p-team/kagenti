// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0
//
// Query 04: Which principals have ever caused agent X to call tool Y?
// Both agent and tool filters are required; shows an instruction state when either is missing.

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
import { FilterIcon } from '@patternfly/react-icons';
import { useQuery } from '@tanstack/react-query';

import { lineageService } from '@/services/lineageService';
import type { LineageFilters } from '@/types/lineage';

interface Props {
  filters: LineageFilters;
}

export const PathsPanel: React.FC<Props> = ({ filters }) => {
  const ready = Boolean(filters.agent && filters.tool);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-paths', filters.agent, filters.tool],
    queryFn: () => lineageService.getPaths(filters.agent, filters.tool),
    enabled: ready,
    staleTime: 30_000,
  });

  if (!ready) {
    return (
      <EmptyState>
        <EmptyStateHeader
          titleText="Set agent and tool filters"
          headingLevel="h4"
          icon={<EmptyStateIcon icon={FilterIcon} />}
        />
        <EmptyStateBody>
          Enter both an <strong>agent</strong> (e.g. <code>booking-agent</code>) and a{' '}
          <strong>tool</strong> (e.g. <code>sanctions-screen</code>) in the filter bar above
          to see which principals triggered that path.
        </EmptyStateBody>
      </EmptyState>
    );
  }

  if (isLoading) return <Spinner />;
  if (isError)
    return <Alert variant="danger" title={String((error as Error)?.message ?? 'Error loading paths')} />;

  if (!data || data.length === 0) {
    return (
      <EmptyState>
        <EmptyStateHeader
          titleText="No results"
          headingLevel="h4"
          icon={<EmptyStateIcon icon={FilterIcon} />}
        />
        <EmptyStateBody>
          No principal has triggered <code>{filters.agent}</code> → <code>{filters.tool}</code> yet.
        </EmptyStateBody>
      </EmptyState>
    );
  }

  return (
    <>
      <p style={{ marginBottom: 8, fontSize: 13, color: '#666' }}>
        Principals that triggered <code>{filters.agent}</code> → <code>{filters.tool}</code>
      </p>
      <Table aria-label="Principal paths" variant="compact">
        <Thead>
          <Tr>
            <Th>Principal</Th>
            <Th modifier="nowrap">Call count</Th>
            <Th>First seen</Th>
            <Th>Last seen</Th>
          </Tr>
        </Thead>
        <Tbody>
          {data.map((p, i) => (
            <Tr key={i}>
              <Td>{p.principal_id}</Td>
              <Td>
                <span style={{ fontWeight: 600 }}>{p.count}</span>
              </Td>
              <Td>{new Date(p.first_seen).toLocaleString()}</Td>
              <Td>{new Date(p.last_seen).toLocaleString()}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </>
  );
};
