/**
 * Pure sort/grouping helpers for the Flows list surface (#92 follow-up).
 *
 * Extracted verbatim from the inline logic that used to live in
 * `Flow/FlowDashboard/FlowDashboard.tsx`, so the dashboard AND the new flow
 * pickers can share ONE source of truth for sort order + sort-derived
 * bucketing. Kept free of React/MUI so it is unit-testable in the node-env
 * Jest harness (mirrors `modelGrouping.ts`).
 */
import { alphaBucket } from '@/utils/shared/cardGrouping';

/** Sort keys for the Flows surface. */
export type FlowSortOption =
  | 'name-asc'
  | 'name-desc'
  | 'newest'
  | 'oldest'
  | 'most-nodes'
  | 'least-nodes';

export const FLOW_SORT_LABELS: Record<FlowSortOption, string> = {
  'name-asc': 'Name (A-Z)',
  'name-desc': 'Name (Z-A)',
  'newest': 'Newest first',
  'oldest': 'Oldest first',
  'most-nodes': 'Most nodes',
  'least-nodes': 'Least nodes',
};

/**
 * The minimal shape the sort/grouping logic reads off a flow. The frontend
 * `Flow` type is structurally assignable to this, so callers pass their own
 * richer type and `sortFlows` returns it unchanged (generic).
 */
export interface FlowGroupingItem {
  id: string;
  name: string;
  nodes: unknown[];
  /** Optional favorite flag (#120). Favorites float to the top of the list. */
  favorite?: boolean;
}

/** Node-count bucket for the "most/least nodes" sort (#73). */
export function bucketNodeCount(count: number): { key: string; label: string } {
  if (count === 0) return { key: 'nodes:0', label: '0 nodes' };
  if (count <= 2) return { key: 'nodes:1-2', label: '1–2 nodes' };
  if (count <= 5) return { key: 'nodes:3-5', label: '3–5 nodes' };
  if (count <= 10) return { key: 'nodes:6-10', label: '6–10 nodes' };
  return { key: 'nodes:11+', label: '11+ nodes' };
}

/**
 * Map the active sort key to a group bucket for a flow. Alphabetical sorts fold
 * by first letter; node-count sorts fold by size band; date sorts (which lack a
 * real timestamp on the Flow type) fall back to a single bucket.
 */
export function deriveFlowSortGroup(
  flow: FlowGroupingItem,
  sortOption: FlowSortOption,
): { key: string; label: string } {
  switch (sortOption) {
    case 'name-asc':
    case 'name-desc':
      return alphaBucket(flow.name);
    case 'most-nodes':
    case 'least-nodes':
      return bucketNodeCount(flow.nodes.length);
    default:
      return { key: 'all', label: 'All flows' };
  }
}

/**
 * Comparator for the active sort key. `newest`/`oldest` sort by id (the Flow
 * type has no real timestamp — preserved from the previous inline behaviour).
 */
export function compareFlows(
  sortOption: FlowSortOption,
): (a: FlowGroupingItem, b: FlowGroupingItem) => number {
  return (a, b) => {
    switch (sortOption) {
      case 'name-asc':
        return a.name.localeCompare(b.name);
      case 'name-desc':
        return b.name.localeCompare(a.name);
      case 'most-nodes':
        return b.nodes.length - a.nodes.length;
      case 'least-nodes':
        return a.nodes.length - b.nodes.length;
      // For newest/oldest we would need timestamps on the Flow type; this
      // placeholder uses IDs, which may not be timestamp-based.
      case 'newest':
        return b.id.localeCompare(a.id);
      case 'oldest':
        return a.id.localeCompare(b.id);
      default:
        return 0;
    }
  };
}

/** Sort a copy of `flows` by the active sort key, leaving the input untouched. */
export function sortFlows<T extends FlowGroupingItem>(flows: T[], sortOption: FlowSortOption): T[] {
  return [...flows].sort(compareFlows(sortOption));
}

/**
 * Sort a copy of `flows` favorites-first (#120): favorited flows are grouped
 * ahead of the rest, and within each partition the active `sortOption` ordering
 * still applies. Pure/React-free so it can be shared by the dashboard AND the
 * Chat flow picker, and unit-tested in the node-env Jest harness. The input is
 * left untouched.
 */
export function sortFlowsFavoritesFirst<T extends FlowGroupingItem>(
  flows: T[],
  sortOption: FlowSortOption,
): T[] {
  const cmp = compareFlows(sortOption);
  return [...flows].sort((a, b) => {
    const favDelta = Number(Boolean(b.favorite)) - Number(Boolean(a.favorite));
    if (favDelta !== 0) return favDelta;
    return cmp(a, b);
  });
}
