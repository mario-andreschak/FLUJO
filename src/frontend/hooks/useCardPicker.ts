"use client";

import { useCallback, useMemo, useState } from 'react';
import { useWorkspaceUiPreference } from '@/frontend/hooks/useUiPreference';
import {
  CardGroup,
  DEFAULT_CARD_GROUP_MODE,
  groupByFolder,
  groupItems,
} from '@/utils/shared/cardGrouping';
import {
  ModelSortOption,
  deriveModelSortGroup,
  sortModelsFavoritesFirst,
  modelDisplayName,
} from '@/utils/shared/modelGrouping';
import {
  ServerSortOption,
  deriveServerSortGroup,
  sortServersFavoritesFirst,
} from '@/utils/shared/serverGrouping';
import {
  FlowSortOption,
  deriveFlowSortGroup,
  sortFlowsFavoritesFirst,
} from '@/utils/shared/flowGrouping';
import type { Model } from '@/shared/types';
import type { ServerGroupingItem } from '@/utils/shared/serverGrouping';
import type { FlowGroupingItem } from '@/utils/shared/flowGrouping';

/**
 * Shared "picker view-model" hook (#92 follow-up).
 *
 * Given one of the three card domains and its raw list, this centralises the
 * management pages' saved view preferences (`flujo-ui:<domain>:*`) plus the
 * shared grouping helpers so a picker renders the SAME search + sort + folder
 * grouping the user configured on the corresponding management page — without
 * re-implementing the preference-key plumbing per picker.
 *
 * It only READS the persisted sort/group prefs (the picker doesn't change the
 * management page's settings); the search term is local to the picker session.
 */
export type CardPickerDomain = 'models' | 'mcp' | 'flows';
type GroupMode = 'none' | 'folder' | 'sort';

// Per-domain access: how to sort, bucket, find the folder, and build the
// searchable text for an item. Typed loosely (any) internally because the three
// domains have unrelated item shapes; the public hook stays generic in <T>.
interface DomainAdapter {
  defaultSort: string;
  sort: (items: unknown[], sort: string) => unknown[];
  deriveSortGroup: (item: unknown, sort: string) => { key: string; label: string };
  getFolder: (item: unknown) => string | undefined;
  getSearchText: (item: unknown) => string;
}

type PickerRecord = Record<string, unknown>;

const asPickerRecord = (item: unknown): PickerRecord => item as PickerRecord;
const optionalString = (value: unknown): string | undefined => (
  typeof value === 'string' ? value : undefined
);

const ADAPTERS: Record<CardPickerDomain, DomainAdapter> = {
  models: {
    defaultSort: 'name-asc',
    // Favorites-first (#146) so favorited models surface at the top of every
    // model picker routed through the hook, matching the dashboard's ordering.
    sort: (items, s) => sortModelsFavoritesFirst(items as Model[], s as ModelSortOption),
    deriveSortGroup: (item, s) => deriveModelSortGroup(item as Model, s as ModelSortOption),
    getFolder: (item) => optionalString(asPickerRecord(item).folder),
    getSearchText: (item) => {
      const model = item as Model;
      return `${modelDisplayName(model)} ${model.name ?? ''}`;
    },
  },
  mcp: {
    defaultSort: 'name-asc',
    // Favorites-first (#146) so favorited servers surface at the top of every
    // server picker routed through the hook, matching the manager's ordering.
    sort: (items, s) => sortServersFavoritesFirst(items as ServerGroupingItem[], s as ServerSortOption),
    deriveSortGroup: (item, s) => deriveServerSortGroup(item as ServerGroupingItem, s as ServerSortOption),
    getFolder: (item) => optionalString(asPickerRecord(item).folder),
    getSearchText: (item) => {
      const record = asPickerRecord(item);
      return `${optionalString(record.name) ?? ''} ${optionalString(record.rootPath) ?? optionalString(record.path) ?? ''}`;
    },
  },
  flows: {
    defaultSort: 'name-asc',
    // Favorites-first (#120) so favorited flows surface at the top of every
    // flow picker routed through the hook, matching the dashboard's ordering.
    sort: (items, s) => sortFlowsFavoritesFirst(items as FlowGroupingItem[], s as FlowSortOption),
    deriveSortGroup: (item, s) => deriveFlowSortGroup(item as FlowGroupingItem, s as FlowSortOption),
    getFolder: (item) => optionalString(asPickerRecord(item).folder),
    getSearchText: (item) => optionalString(asPickerRecord(item).name) ?? '',
  },
};

export interface UseCardPickerResult<T> {
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  /** The active saved sort key for the domain (read-only mirror). */
  sortOption: string;
  /** The active saved group mode for the domain (read-only mirror). */
  groupMode: GroupMode;
  /** Flat, filtered + sorted list (always available). */
  items: T[];
  /** Grouped view when `groupMode !== 'none'`; otherwise `null`. */
  groups: CardGroup<T>[] | null;
  /** Collapsed-section keys (mirrors the management page's saved state). */
  collapsedKeys: Set<string>;
  /** Toggle a section's collapse state (persists like the management page). */
  toggleGroup: (key: string) => void;
}

export function useCardPicker<T>(domain: CardPickerDomain, rawList: T[]): UseCardPickerResult<T> {
  const adapter = ADAPTERS[domain];

  const [searchTerm, setSearchTerm] = useState('');
  const [sortOption] = useWorkspaceUiPreference<string>(`flujo-ui:${domain}:sort`, adapter.defaultSort);
  const [groupMode] = useWorkspaceUiPreference<GroupMode>(`flujo-ui:${domain}:group`, DEFAULT_CARD_GROUP_MODE);
  const [collapsedList, setCollapsedList] = useWorkspaceUiPreference<string[]>(`flujo-ui:${domain}:collapsed`, []);
  const collapsedKeys = useMemo(() => new Set(collapsedList), [collapsedList]);

  const items = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const filtered = term
      ? rawList.filter((item) => adapter.getSearchText(item).toLowerCase().includes(term))
      : rawList;
    return adapter.sort([...filtered], sortOption) as T[];
  }, [rawList, searchTerm, sortOption, adapter]);

  const groups = useMemo<CardGroup<T>[] | null>(() => {
    if (groupMode === 'folder') return groupByFolder(items, (i) => adapter.getFolder(i));
    if (groupMode === 'sort') return groupItems(items, (i) => adapter.deriveSortGroup(i, sortOption));
    return null;
  }, [groupMode, items, sortOption, adapter]);

  const toggleGroup = useCallback(
    (key: string) => {
      setCollapsedList((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    },
    [setCollapsedList],
  );

  return { searchTerm, setSearchTerm, sortOption, groupMode, items, groups, collapsedKeys, toggleGroup };
}
