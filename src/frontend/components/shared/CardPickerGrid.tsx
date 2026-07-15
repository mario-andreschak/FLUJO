"use client";

import React, { useState } from 'react';
import { Box, Grid, Typography, CircularProgress, TextField, InputAdornment } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CollapsibleCardSection from './CollapsibleCardSection';
import { CardGroup } from '@/utils/shared/cardGrouping';

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
  /**
   * Optional searchable text for this item. Only used for the grid's
   * *uncontrolled* search fallback (when `searchable` is on but no
   * `onSearchChange` is supplied). Controlled callers pre-filter their items
   * and this is ignored.
   */
  searchText?: string;
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
  /**
   * Flat list of items. Rendered as a single grid when {@link groups} is not
   * provided. Optional so callers can pass `groups` instead.
   */
  items?: CardPickerItem[];

  // ── #92 follow-up: optional search + grouping (all additive/opt-in) ─────────
  /** Render a search box above the grid. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Controlled search term. When provided, the caller owns filtering. */
  searchTerm?: string;
  /** Controlled search handler; pairs with {@link searchTerm}. */
  onSearchChange?: (value: string) => void;
  /**
   * When provided, render each group inside a collapsible section instead of
   * one flat grid. Grouping/sorting is computed by the caller (e.g. via
   * `useCardPicker`) so this primitive stays domain-agnostic.
   */
  groups?: CardGroup<CardPickerItem>[] | null;
  /** Controlled collapsed-section keys; pairs with {@link onToggleGroup}. */
  collapsedKeys?: Set<string>;
  /** Controlled collapse toggler; when omitted the grid manages its own. */
  onToggleGroup?: (key: string) => void;
}

const DEFAULT_COLUMNS: CardPickerColumns = { xs: 12, sm: 6, md: 4 };

/**
 * A generic, responsive grid wrapper shared by every card-based picker (flows,
 * models, MCP servers, subflows). It centralises the loading / empty / error
 * states and equal-height cells so all pickers look and behave the same and
 * can't visually drift from one another.
 *
 * Optionally (#92 follow-up) it renders a search box and/or collapsible groups
 * so pickers can match the management pages' search + sort/folder grouping. All
 * of that is opt-in: callers that pass only `items` get the original flat grid.
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
  searchable = false,
  searchPlaceholder = 'Search…',
  searchTerm,
  onSearchChange,
  groups,
  collapsedKeys,
  onToggleGroup,
}) => {
  const cols = { ...DEFAULT_COLUMNS, ...columns };

  // Search state: controlled when `searchTerm` is passed, otherwise internal.
  const [internalSearch, setInternalSearch] = useState('');
  const isSearchControlled = searchTerm !== undefined;
  const effectiveTerm = isSearchControlled ? (searchTerm as string) : internalSearch;
  const handleSearch = (value: string) => {
    onSearchChange?.(value);
    if (!isSearchControlled) setInternalSearch(value);
  };

  // Collapse state: controlled when `collapsedKeys` is passed, else internal.
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(new Set());
  const effectiveCollapsed = collapsedKeys ?? internalCollapsed;
  const handleToggleGroup = (key: string) => {
    if (onToggleGroup) {
      onToggleGroup(key);
      return;
    }
    setInternalCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderCells = (cells: CardPickerItem[]) => (
    <Grid container spacing={2} alignItems="stretch">
      {cells.map((item) => (
        <Grid item xs={cols.xs} sm={cols.sm} md={cols.md} lg={cols.lg} key={item.key} sx={{ display: 'flex' }}>
          <Box sx={{ width: '100%' }}>{item.content}</Box>
        </Grid>
      ))}
    </Grid>
  );

  const searchBox = searchable ? (
    <TextField
      placeholder={searchPlaceholder}
      variant="outlined"
      size="small"
      fullWidth
      value={effectiveTerm}
      onChange={(e) => handleSearch(e.target.value)}
      sx={{ mb: 2 }}
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <SearchIcon fontSize="small" />
          </InputAdornment>
        ),
      }}
    />
  ) : null;

  const withSearch = (body: React.ReactNode) => (
    <Box>
      {searchBox}
      {body}
    </Box>
  );

  if (isLoading) {
    if (skeleton) {
      return withSearch(
        <Grid container spacing={2}>
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <Grid item xs={cols.xs} sm={cols.sm} md={cols.md} lg={cols.lg} key={`skeleton-${i}`}>
              {skeleton}
            </Grid>
          ))}
        </Grid>,
      );
    }
    return withSearch(
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
        <CircularProgress size={20} />
        <Typography variant="body2" color="text.secondary">
          {loadingMessage}
        </Typography>
      </Box>,
    );
  }

  if (error) {
    return withSearch(
      <Typography color="error" variant="body2" sx={{ py: 2 }}>
        {error}
      </Typography>,
    );
  }

  // Uncontrolled search filters by each item's `searchText`. Controlled callers
  // pre-filter, so no client-side filtering happens for them here.
  const uncontrolledTerm = !isSearchControlled ? effectiveTerm.trim().toLowerCase() : '';
  const matches = (item: CardPickerItem) =>
    !uncontrolledTerm || (item.searchText ?? '').toLowerCase().includes(uncontrolledTerm);

  const empty = (
    <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
      {emptyMessage}
    </Typography>
  );

  // Grouped rendering (collapsible sections).
  if (groups) {
    const visibleGroups = groups
      .map((g) => ({ ...g, items: g.items.filter(matches) }))
      .filter((g) => g.items.length > 0);

    if (visibleGroups.length === 0) return withSearch(empty);

    return withSearch(
      <>
        {visibleGroups.map((group) => (
          <CollapsibleCardSection
            key={group.key}
            label={group.label}
            count={group.items.length}
            expanded={!effectiveCollapsed.has(group.key)}
            onToggle={() => handleToggleGroup(group.key)}
          >
            {renderCells(group.items)}
          </CollapsibleCardSection>
        ))}
      </>,
    );
  }

  // Flat rendering (default / original behavior).
  const visibleItems = (items ?? []).filter(matches);
  if (visibleItems.length === 0) return withSearch(empty);

  return withSearch(renderCells(visibleItems));
};

export default CardPickerGrid;
