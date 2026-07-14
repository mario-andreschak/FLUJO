"use client";

import React from 'react';
import { Box, Grid, Typography, CircularProgress } from '@mui/material';

export interface CardPickerColumns {
  xs?: number;
  sm?: number;
  md?: number;
  lg?: number;
}

export interface CardPickerItem {
  /** Stable key for the grid cell. */
  key: string | number;
  /** The card to render (usually a domain card in "picker" mode). */
  content: React.ReactNode;
}

export interface CardPickerGridProps {
  /** While true, render skeletons (or a spinner) instead of items. */
  isLoading?: boolean;
  /** When set, an error message is shown instead of the grid. */
  error?: string | null;
  /** Shown when there are no items and we're not loading/erroring. */
  emptyMessage?: React.ReactNode;
  /** Caption shown next to the spinner while loading (when no skeleton given). */
  loadingMessage?: React.ReactNode;
  /** Optional skeleton element rendered `skeletonCount` times while loading. */
  skeleton?: React.ReactNode;
  skeletonCount?: number;
  /** Responsive column span per breakpoint (MUI Grid item units, 12-based). */
  columns?: CardPickerColumns;
  items: CardPickerItem[];
}

const DEFAULT_COLUMNS: CardPickerColumns = { xs: 12, sm: 6, md: 4 };

/**
 * A generic, responsive grid wrapper shared by every card-based picker (flows,
 * models, MCP servers, subflows). It centralises the loading / empty / error
 * states and equal-height cells so all pickers look and behave the same and
 * can't visually drift from one another.
 */
const CardPickerGrid: React.FC<CardPickerGridProps> = ({
  isLoading = false,
  error = null,
  emptyMessage = 'Nothing to choose from.',
  loadingMessage = 'Loading…',
  skeleton,
  skeletonCount = 4,
  columns = DEFAULT_COLUMNS,
  items,
}) => {
  const cols = { ...DEFAULT_COLUMNS, ...columns };

  if (isLoading) {
    if (skeleton) {
      return (
        <Grid container spacing={2}>
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <Grid item xs={cols.xs} sm={cols.sm} md={cols.md} lg={cols.lg} key={`skeleton-${i}`}>
              {skeleton}
            </Grid>
          ))}
        </Grid>
      );
    }
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
        <CircularProgress size={20} />
        <Typography variant="body2" color="text.secondary">
          {loadingMessage}
        </Typography>
      </Box>
    );
  }

  if (error) {
    return (
      <Typography color="error" variant="body2" sx={{ py: 2 }}>
        {error}
      </Typography>
    );
  }

  if (!items || items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
        {emptyMessage}
      </Typography>
    );
  }

  return (
    <Grid container spacing={2} alignItems="stretch">
      {items.map((item) => (
        <Grid item xs={cols.xs} sm={cols.sm} md={cols.md} lg={cols.lg} key={item.key} sx={{ display: 'flex' }}>
          <Box sx={{ width: '100%' }}>{item.content}</Box>
        </Grid>
      ))}
    </Grid>
  );
};

export default CardPickerGrid;
