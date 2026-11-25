import { createHash } from 'node:crypto';

/**
 * Items people edit together in a team workspace (#575): flows, models and
 * MCP servers. Change history, the "someone else saved first" check and the
 * "Anna is editing" notes all speak about these kinds.
 *
 * Everything in `src/backend/services/sharedItems/` only acts while
 * multi-user mode is on; with it off, FLUJO behaves exactly as before.
 */

export const SHARED_ITEM_KINDS = ['flow', 'model', 'mcp-server'] as const;
export type SharedItemKind = typeof SHARED_ITEM_KINDS[number];

/** Words for messages: "Someone else saved this flow …". */
export const SHARED_ITEM_LABELS: Readonly<Record<SharedItemKind, string>> = Object.freeze({
  flow: 'flow',
  model: 'model',
  'mcp-server': 'MCP server',
});

export function isSharedItemKind(value: unknown): value is SharedItemKind {
  return typeof value === 'string' && (SHARED_ITEM_KINDS as readonly string[]).includes(value);
}

/** Ids are flow ids, model ids and MCP server names. Bounded so they stay cheap to hash and log. */
export function isSharedItemId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
}

/** JSON with object keys in a fixed order, so the same content always gives the same text. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/**
 * The version of an item as the editor sees it. Flows carry a server-stamped
 * `updatedAt`, so the builder knows the version it opened without asking.
 * Models and MCP servers have no such stamp, so their version is a short hash
 * of what the item route answers (secrets masked, as the editor sees them).
 */
export function itemRevision(kind: SharedItemKind, item: unknown): string {
  if (kind === 'flow') {
    const updatedAt = (item as { updatedAt?: unknown } | null)?.updatedAt;
    return `f${typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0}`;
  }
  return `h${createHash('sha256').update(stableStringify(item)).digest('hex').slice(0, 32)}`;
}
