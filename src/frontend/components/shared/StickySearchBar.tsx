"use client";

import React from 'react';
import { Box, SxProps, Theme, useTheme } from '@mui/material';

export interface StickySearchBarProps {
  children: React.ReactNode;
  /**
   * `'container'` — sticky against the nearest `overflow: auto` ancestor
   * (`top: 0`, for scroll containers such as dialogs and the flow/MCP dashboards).
   * `'page'` — sticky against the window, offset below the app bar and any
   * active sub-navigation (for document-scrolled pages such as Models and
   * Automations).
   */
  mode?: 'container' | 'page';
  /** Render children unchanged, with no sticky positioning. */
  disableSticky?: boolean;
  /** Extra offset added on top of the computed `top` (number = px). */
  offset?: number | string;
  sx?: SxProps<Theme>;
}

/**
 * Keeps a search field visible while its list scrolls underneath it (#372).
 * Purely presentational: it never traps or reorders focus.
 */
const StickySearchBar: React.FC<StickySearchBarProps> = ({
  children,
  mode = 'container',
  disableSticky = false,
  offset = 0,
  sx,
}) => {
  const theme = useTheme();

  if (disableSticky) {
    return <Box sx={sx}>{children}</Box>;
  }

  const baseTop =
    mode === 'page' ? 'calc(var(--app-bar-height) + var(--active-subnav-height))' : '0px';
  const offsetExpr =
    typeof offset === 'number' ? `${offset}px` : offset ? offset : '0px';
  const top = offset ? `calc(${baseTop} + ${offsetExpr})` : baseTop;

  return (
    <Box
      sx={{
        position: 'sticky',
        top,
        zIndex: theme.zIndex.appBar - 1,
        bgcolor: mode === 'page' ? 'background.default' : 'background.paper',
        ...sx,
      }}
    >
      {children}
    </Box>
  );
};

export default StickySearchBar;
