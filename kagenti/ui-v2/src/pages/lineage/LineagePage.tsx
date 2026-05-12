// Copyright 2025 IBM Corp.
// Licensed under the Apache License, Version 2.0
//
// Drop-in page for: kagenti/kagenti/ui-v2/src/pages/lineage/LineagePage.tsx
// Route:  /lineage  (add to App.tsx — see routing/app_route_snippet.tsx)
// Nav:    Observability & Monitoring group (see routing/nav_item_snippet.tsx)

import React, { useState } from 'react';
import {
  PageSection,
  Title,
  Tab,
  Tabs,
  TabTitleText,
} from '@patternfly/react-core';

import { LineageFilterBar } from './LineageFilterBar';
import { TrajectoriesPanel } from './panels/TrajectoriesPanel';
import { CommonEdgesPanel } from './panels/CommonEdgesPanel';
import { PathsPanel } from './panels/PathsPanel';
import type { LineageFilters } from './types';

const DEFAULT_FILTERS: LineageFilters = {
  username: '',
  agent: '',
  tool: '',
  timeRange: '24h',
};

export const LineagePage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<number>(0);
  const [filters, setFilters] = useState<LineageFilters>(DEFAULT_FILTERS);

  return (
    <>
      <PageSection variant="light" padding={{ default: 'noPadding' }}>
        <div style={{ padding: '16px 24px 0' }}>
          <Title headingLevel="h1" size="xl">Data Lineage</Title>
          <p style={{ color: '#666', marginTop: 4 }}>
            Trust provenance graph — who authorized what, which agents delegate to which,
            which principals reach which tools.
          </p>
        </div>
        <LineageFilterBar filters={filters} onChange={setFilters} />
      </PageSection>

      <PageSection>
        <Tabs
          activeKey={activeTab}
          onSelect={(_e, k) => setActiveTab(Number(k))}
          aria-label="Data lineage views"
        >
          <Tab eventKey={0} title={<TabTitleText>Trajectories</TabTitleText>}>
            <div style={{ marginTop: 16 }}>
              <TrajectoriesPanel filters={filters} />
            </div>
          </Tab>

          <Tab eventKey={1} title={<TabTitleText>Delegation Graph</TabTitleText>}>
            <div style={{ marginTop: 16 }}>
              <CommonEdgesPanel filters={filters} />
            </div>
          </Tab>

          <Tab eventKey={2} title={<TabTitleText>Principal Paths</TabTitleText>}>
            <div style={{ marginTop: 16 }}>
              <PathsPanel filters={filters} />
            </div>
          </Tab>
        </Tabs>
      </PageSection>
    </>
  );
};
