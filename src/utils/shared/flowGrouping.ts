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
  /** Optional server-managed creation time, epoch ms (#108). */
  createdAt?: number;
  /** Optional server-managed last-modified time, epoch ms (#108). */
  updatedAt?: number;
}

/**
 * The timestamp the date sorts/buckets read off a flow: last-modified time,
 * falling back to creation time, then 0 for flows that carry neither (#108).
 */
export function flowTimestamp(flow: FlowGroupingItem): number {
  return flow.updatedAt ?? flow.createdAt ?? 0;
}

/**
 * Coarse recency bucket for the date sorts (#108). Uses rolling windows from
 * `now` (injectable for deterministic tests). Flows with no timestamp fold into
 * a dedicated "No date" bucket rather than being mislabelled as old.
 */
export function recencyBucket(ts: number, now: number = Date.now()): { key: string; label: string } {
  if (!ts) return { key: 'recency:unknown', label: 'No date' };
  const DAY = 24 * 60 * 60 * 1000;
  const age = now - ts;
  if (age < DAY) return { key: 'recency:today', label: 'Today' };
  if (age < 7 * DAY) return { key: 'recency:week', label: 'This week' };
  if (age < 30 * DAY) return { key: 'recency:month', label: 'This month' };
  return { key: 'recency:older', label: 'Older' };
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
 * by first letter; node-count sorts fold by size band; date sorts fold into
 * coarse recency buckets (Today / This week / This month / Older) from the
 * flow's timestamp (#108).
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
    case 'newest':
    case 'oldest':
      return recencyBucket(flowTimestamp(flow));
    default:
      return { key: 'all', label: 'All flows' };
  }
}

/**
 * A deterministic tiebreak so flows with equal (or missing) timestamps still
 * sort in a stable, repeatable order: by name, then by id.
 */
function stableTiebreak(a: FlowGroupingItem, b: FlowGroupingItem): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Comparator for the active sort key. `newest`/`oldest` sort by the flow's real
 * timestamp (`updatedAt ?? createdAt`), newest/oldest respectively, with a
 * deterministic name-then-id tiebreak (#108). Flows lacking a timestamp use 0,
 * so they sort last under "newest" and first under "oldest", always stably.
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
      case 'newest': {
        const delta = flowTimestamp(b) - flowTimestamp(a);
        return delta !== 0 ? delta : stableTiebreak(a, b);
      }
      case 'oldest': {
        const delta = flowTimestamp(a) - flowTimestamp(b);
        return delta !== 0 ? delta : stableTiebreak(a, b);
      }
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
