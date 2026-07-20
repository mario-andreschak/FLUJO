"use client";

import React from 'react';
import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import type { DependencyList } from 'react';
import { useScrollRestoration } from '@/frontend/hooks/useScrollRestoration';
import BackToTopButton from './BackToTopButton';

export interface ScrollAreaProps {
  /** localStorage key under which the scroll position is persisted (namespaced `flujo-ui:scroll:*`). */
  storageKey: string;
  /** sx applied to the scrolling Box. `overflow: 'auto'` is enforced. */
  sx?: SxProps<Theme>;
  /** Pixels scrolled before the back-to-top button appears. */
  threshold?: number;
  /** Re-attempt restoration when these change (async content that grows after mount). */
  deps?: DependencyList;
  children: React.ReactNode;
}

/**
 * A scrollable region that persists its scroll position across navigation and
 * shows a back-to-top button once scrolled past a threshold (#185). Handy for
 * server components (e.g. the Models page) that cannot use the hook directly —
 * it packages the hook + button behind a single client boundary.
 */
export default function ScrollArea({ storageKey, sx, threshold, deps, children }: ScrollAreaProps) {
  const { ref, showBackToTop, scrollToTop } = useScrollRestoration<HTMLDivElement>(storageKey, {
    threshold,
    deps,
  });

  return (
    <>
      <Box ref={ref} sx={{ ...sx, overflow: 'auto' }}>
        {children}
      </Box>
      <BackToTopButton show={showBackToTop} onClick={scrollToTop} />
    </>
  );
}
