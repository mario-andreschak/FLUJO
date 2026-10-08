"use client";

import React from 'react';
import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import type { DependencyList } from 'react';
import ScrollNavCluster from './ScrollNavCluster';
import type { ScrollNavAction } from './ScrollNavCluster';
import { useListScrollNav } from '@/frontend/hooks/useListScrollNav';

export interface ScrollAreaProps {
  /** localStorage key under which the scroll position is persisted (namespaced `flujo-ui:scroll:*`). */
  storageKey: string;
  /** sx applied to the scrolling Box. `overflow: 'auto'` is enforced. */
  sx?: SxProps<Theme>;
  /** Re-attempt restoration when these change (async content that grows after mount). */
  deps?: DependencyList;
  /**
   * Scroll navigation cluster (#376). `true` (default) renders the full
   * top / previous folder / next folder / bottom cluster; pass an explicit
   * action list to trim it, or `false` to opt out entirely.
   */
  nav?: boolean | ScrollNavAction[];
  children: React.ReactNode;
}

/**
 * A scrollable region that persists its scroll position across navigation
 * (#185) and hosts the scroll navigation cluster (#376). Handy for server
 * components (e.g. the Models page) that cannot use the hooks directly — it
 * packages them behind a single client boundary.
 */
export default function ScrollArea({ storageKey, sx, deps, nav = true, children }: ScrollAreaProps) {
  const { ref, clusterProps } = useListScrollNav<HTMLDivElement>(storageKey, { deps });

  return (
    <>
      <Box ref={ref} sx={{ ...sx, overflow: 'auto' }}>
        {children}
      </Box>
      {nav !== false && (
        <ScrollNavCluster
          {...clusterProps}
          {...(Array.isArray(nav) ? { actions: nav } : {})}
        />
      )}
    </>
  );
}
