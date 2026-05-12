// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0
//
// Query 01: Runs for a principal in the selected time window.
// Clicking a row opens TrajectoryDetail.

import React, { useState } from 'react';
import {
  Button,
  EmptyState,
  EmptyStateHeader,
  EmptyStateIcon,
  EmptyStateBody,
  Modal,
  ModalVariant,
  Spinner,
  Alert,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
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
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { lineageService } from '@/services/lineageService';
import { TrajectoryDetail } from './TrajectoryDetail';
import type { LineageFilters, Run } from '@/types/lineage';

interface Props {
  filters: LineageFilters;
}

export const TrajectoriesPanel: React.FC<Props> = ({ filters }) => {
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmModal, setConfirmModal] = useState<'selected' | 'all' | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['lineage-runs', filters.username, filters.agent, filters.tool, filters.timeRange],
    queryFn: () =>
      lineageService.listRuns({
        username: filters.username || undefined,
        agent: filters.agent || undefined,
        tool: filters.tool || undefined,
        timeRange: filters.timeRange,
        limit: 100,
      }),
    staleTime: 30_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['lineage-runs'] });

  const handleDeleteSelected = async () => {
    setIsDeleting(true);
    try {
      await Promise.all([...selectedIds].map((id) => lineageService.deleteRun(id)));
      setSelectedIds(new Set());
      await invalidate();
    } finally {
      setIsDeleting(false);
      setConfirmModal(null);
    }
  };

  const handleDeleteAll = async () => {
    setIsDeleting(true);
    try {
      await lineageService.deleteAllRuns();
      setSelectedIds(new Set());
      await invalidate();
    } finally {
      setIsDeleting(false);
      setConfirmModal(null);
    }
  };

  const toggleRow = (runId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId); else next.add(runId);
      return next;
    });
  };

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
          {filters.username
            ? `No runs found for user "${filters.username}" in the selected time range.`
            : 'No runs recorded yet. Try a different time range or trigger an agent chain.'}
        </EmptyStateBody>
      </EmptyState>
    );
  }

  return (
    <>
      <Toolbar style={{ paddingLeft: 0 }}>
        <ToolbarContent>
          <ToolbarItem>
            <Button
              variant="danger"
              isDisabled={selectedIds.size === 0 || isDeleting}
              onClick={() => setConfirmModal('selected')}
            >
              Delete selected ({selectedIds.size})
            </Button>
          </ToolbarItem>
          <ToolbarItem>
            <Button
              variant="secondary"
              isDanger
              isDisabled={isDeleting}
              onClick={() => setConfirmModal('all')}
            >
              Clear all
            </Button>
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>

      <Table aria-label="Runs" variant="compact">
        <Thead>
          <Tr>
            <Th screenReaderText="Row select" />
            <Th>User</Th>
            <Th>Started</Th>
            <Th>Hops</Th>
            <Th>Trace ID</Th>
          </Tr>
        </Thead>
        <Tbody>
          {data.map((run, rowIndex) => (
            <Tr
              key={run.run_id}
              isClickable
              onRowClick={() => setSelectedRun(run)}
            >
              <Td
                select={{
                  rowIndex,
                  onSelect: () => {
                    toggleRow(run.run_id);
                  },
                  isSelected: selectedIds.has(run.run_id),
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <Td>{run.username ?? '—'}</Td>
              <Td>{new Date(run.started_at).toLocaleString()}</Td>
              <Td>{run.hop_count}</Td>
              <Td>
                <code style={{ fontSize: '0.75em' }}>{run.trace_id.slice(0, 16)}…</code>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      <Modal
        variant={ModalVariant.small}
        title="Delete selected runs?"
        isOpen={confirmModal === 'selected'}
        onClose={() => setConfirmModal(null)}
        actions={[
          <Button key="confirm" variant="danger" isLoading={isDeleting} onClick={handleDeleteSelected}>
            Delete {selectedIds.size} run{selectedIds.size !== 1 ? 's' : ''}
          </Button>,
          <Button key="cancel" variant="link" onClick={() => setConfirmModal(null)}>Cancel</Button>,
        ]}
      >
        This will permanently delete {selectedIds.size} selected run{selectedIds.size !== 1 ? 's' : ''} and all their hop data.
      </Modal>

      <Modal
        variant={ModalVariant.small}
        title="Clear all lineage data?"
        isOpen={confirmModal === 'all'}
        onClose={() => setConfirmModal(null)}
        actions={[
          <Button key="confirm" variant="danger" isLoading={isDeleting} onClick={handleDeleteAll}>
            Delete all
          </Button>,
          <Button key="cancel" variant="link" onClick={() => setConfirmModal(null)}>Cancel</Button>,
        ]}
      >
        This will permanently delete <strong>all</strong> runs, hops, and edge statistics.
        This cannot be undone.
      </Modal>
    </>
  );
};
