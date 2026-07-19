/**
 * Pure sort/grouping helpers for the MCP Servers list surface (#92 follow-up).
 *
 * Extracted verbatim from the inline logic that used to live in
 * `mcp/MCPServerManager/index.tsx`, so the management page AND the new server
 * pickers (MCP node binding, "watch a tool" trigger) can share ONE source of
 * truth for sort order + sort-derived bucketing. Kept free of React/MUI so it
 * is unit-testable in the node-env Jest harness (mirrors `modelGrouping.ts`).
 */
import { alphaBucket } from '@/utils/shared/cardGrouping';

/** Sort keys for the MCP Servers surface. */
export type ServerSortOption =
  | 'name-asc'
  | 'name-desc'
  | 'status-connected'
  | 'status-disconnected'
  | 'transport';

export const SERVER_SORT_LABELS: Record<ServerSortOption, string> = {
  'name-asc': 'Name (A-Z)',
  'name-desc': 'Name (Z-A)',
  'status-connected': 'Connected first',
  'status-disconnected': 'Disconnected first',
  'transport': 'Transport type',
};

/**
 * The minimal shape the sort/grouping logic reads off a server. Full server
 * config/status objects are structurally assignable to this, so callers pass
 * their own richer type and `sortServers` returns it unchanged (generic).
 */
export interface ServerGroupingItem {
  name: string;
  status?: string;
  transport?: string;
  /** Optional favorite flag (#146). Favorites float to the top of the list. */
  favorite?: boolean;
}

/** Preferred transport ordering for the "Transport type" sort. */
const TRANSPORT_ORDER = ['stdio', 'websocket', 'sse', 'streamable'];

/**
 * Map the active sort key to a group bucket for a server (#73). Alphabetical
 * sorts fold by first letter; status sorts fold by connection status; the
 * transport sort folds by transport type.
 */
export function deriveServerSortGroup(
  server: ServerGroupingItem,
  sortOption: ServerSortOption,
): { key: string; label: string } {
  switch (sortOption) {
    case 'name-asc':
    case 'name-desc':
      return alphaBucket(server.name);
    case 'status-connected':
    case 'status-disconnected': {
      const s = server.status;
      if (s === 'connected') return { key: 'status:connected', label: 'Connected' };
      if (s === 'error') return { key: 'status:error', label: 'Error' };
      if (s === 'requires_authentication') return { key: 'status:auth', label: 'Requires authentication' };
      return { key: 'status:disconnected', label: 'Disconnected' };
    }
    case 'transport': {
      const t = server.transport || 'unknown';
      const labelMap: Record<string, string> = {
        stdio: 'Stdio',
        websocket: 'WebSocket',
        sse: 'SSE',
        streamable: 'Streamable HTTP',
      };
      return { key: `transport:${t}`, label: labelMap[t] || t };
    }
    default:
      return { key: 'all', label: 'All servers' };
  }
}

/**
 * Comparator for the active sort key. Status sorts push the matching status to
 * the front; the transport sort follows {@link TRANSPORT_ORDER}; every branch
 * falls back to a stable name A–Z tie-break (matching the previous inline
 * behaviour byte-for-byte).
 */
export function compareServers(
  sortOption: ServerSortOption,
): (a: ServerGroupingItem, b: ServerGroupingItem) => number {
  return (a, b) => {
    switch (sortOption) {
      case 'name-asc':
        return a.name.localeCompare(b.name);
      case 'name-desc':
        return b.name.localeCompare(a.name);
      case 'status-connected':
        if (a.status === 'connected' && b.status !== 'connected') return -1;
        if (a.status !== 'connected' && b.status === 'connected') return 1;
        return a.name.localeCompare(b.name);
      case 'status-disconnected':
        if (a.status === 'disconnected' && b.status !== 'disconnected') return -1;
        if (a.status !== 'disconnected' && b.status === 'disconnected') return 1;
        return a.name.localeCompare(b.name);
      case 'transport': {
        const aIndex = TRANSPORT_ORDER.indexOf(a.transport ?? '');
        const bIndex = TRANSPORT_ORDER.indexOf(b.transport ?? '');
        if (aIndex !== bIndex) return aIndex - bIndex;
        return a.name.localeCompare(b.name);
      }
      default:
        return 0;
    }
  };
}

/** Sort a copy of `servers` by the active sort key, leaving the input untouched. */
export function sortServers<T extends ServerGroupingItem>(servers: T[], sortOption: ServerSortOption): T[] {
  return [...servers].sort(compareServers(sortOption));
}

/**
 * Sort a copy of `servers` favorites-first (#146, mirrors flows #120): favorited
 * servers are grouped ahead of the rest, and within each partition the active
 * `sortOption` ordering still applies. Pure/React-free so it can be shared by
 * the MCP manager AND every server picker, and unit-tested in the node-env Jest
 * harness. The input is left untouched.
 */
export function sortServersFavoritesFirst<T extends ServerGroupingItem>(
  servers: T[],
  sortOption: ServerSortOption,
): T[] {
  const cmp = compareServers(sortOption);
  return [...servers].sort((a, b) => {
    const favDelta = Number(Boolean(b.favorite)) - Number(Boolean(a.favorite));
    if (favDelta !== 0) return favDelta;
    return cmp(a, b);
  });
}
