// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0

import React from 'react';
import {
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  TextInput,
  ToggleGroup,
  ToggleGroupItem,
} from '@patternfly/react-core';

import type { LineageFilters, TimeRange } from './types';

interface Props {
  filters: LineageFilters;
  onChange: (filters: LineageFilters) => void;
}

const TIME_OPTIONS: { label: string; value: TimeRange }[] = [
  { label: 'Last 1h', value: '1h' },
  { label: 'Last 24h', value: '24h' },
  { label: 'Last 7d', value: '7d' },
  { label: 'All time', value: 'all' },
];

export const LineageFilterBar: React.FC<Props> = ({ filters, onChange }) => {
  const set = (patch: Partial<LineageFilters>) => onChange({ ...filters, ...patch });

  return (
    <Toolbar>
      <ToolbarContent>
        <ToolbarItem>
          <TextInput
            aria-label="Filter by principal"
            placeholder="Principal (user)"
            value={filters.principal}
            onChange={(_e, v) => set({ principal: v })}
          />
        </ToolbarItem>
        <ToolbarItem>
          <TextInput
            aria-label="Filter by agent"
            placeholder="Agent (caller / target)"
            value={filters.agent}
            onChange={(_e, v) => set({ agent: v })}
          />
        </ToolbarItem>
        <ToolbarItem>
          <TextInput
            aria-label="Filter by tool"
            placeholder="Tool (target_id)"
            value={filters.tool}
            onChange={(_e, v) => set({ tool: v })}
          />
        </ToolbarItem>
        <ToolbarItem>
          <ToggleGroup aria-label="Time range">
            {TIME_OPTIONS.map(({ label, value }) => (
              <ToggleGroupItem
                key={value}
                text={label}
                isSelected={filters.timeRange === value}
                onChange={() => set({ timeRange: value })}
              />
            ))}
          </ToggleGroup>
        </ToolbarItem>
      </ToolbarContent>
    </Toolbar>
  );
};
