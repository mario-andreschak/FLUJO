import type { ConversationListItem } from '@/frontend/components/Chat';

/**
 * Parent -> children index + root set for the chat sidebar's "by chain"
 * grouping (issue #182), built from the flat conversation list. Pure and
 * dependency-free so it can be unit-tested in isolation (cycle/orphan guards).
 */
export interface ChainIndex {
  /** Conversations rendered at the top level of the tree. */
  roots: ConversationListItem[];
  /** parentConversationId -> its direct child conversations (input order). */
  childrenByParent: Map<string, ConversationListItem[]>;
  /**
   * Conversations whose DIRECT parent could not be resolved in this set — the
   * parent is on a later sidebar page, hidden by a filter, was deleted, or ran
   * ephemerally and was never persisted.
   *
   * These are either re-attached to their chain root (when that IS loaded) or
   * rendered at the top level. Either way the placement is a fallback, not a
   * real lineage, so the sidebar flags them instead of letting a subflow child
   * masquerade as a genuine chain root (issue #182 follow-up).
   */
  detachedIds: Set<string>;
}

/**
 * Build the chain index for a set of conversations.
 *
 * A conversation is a ROOT when:
 *  - it has no `parentConversationId`, OR
 *  - neither its parent NOR its chain root is present in this set (a filter hid
 *    them, they were deleted, or they are on a later page) — so a matched child
 *    never silently disappears, and
 *  - (defensively) its parent link points at itself.
 *
 * Root fallback: when the direct parent is missing but `rootConversationId` IS
 * loaded, the child is nested under that root rather than promoted to the top
 * level. The sidebar is cursor-paginated (50/page) and a long-running parent
 * sorts BELOW the children it spawns (its sort key freezes at the last *user*
 * message), so an intermediate parent falling off the page was the common way
 * subagent conversations surfaced as first-level rows.
 *
 * Cycle safety net: any node NOT reachable from a root — which can only happen
 * if the persisted parent links form a cycle (they shouldn't, since the root is
 * computed once at creation) — is also promoted to a root, so a corrupt chain
 * degrades to visible rows instead of vanishing. Input ordering is preserved.
 */
export function buildChainIndex(items: ConversationListItem[]): ChainIndex {
  const byId = new Map<string, ConversationListItem>();
  for (const it of items) byId.set(it.id, it);

  const childrenByParent = new Map<string, ConversationListItem[]>();
  const roots: ConversationListItem[] = [];
  const detachedIds = new Set<string>();

  const parentOf = (it: ConversationListItem): string | null =>
    it.parentConversationId && it.parentConversationId !== it.id ? it.parentConversationId : null;
  const rootOf = (it: ConversationListItem): string | null =>
    it.rootConversationId && it.rootConversationId !== it.id ? it.rootConversationId : null;

  const attach = (parentId: string, child: ConversationListItem): void => {
    const arr = childrenByParent.get(parentId) ?? [];
    arr.push(child);
    childrenByParent.set(parentId, arr);
  };

  for (const it of items) {
    const parent = parentOf(it);
    if (parent && byId.has(parent)) {
      attach(parent, it);
      continue;
    }
    if (!parent) {
      // A genuine chain root: automation, user chat, API, ... nothing spawned it.
      roots.push(it);
      continue;
    }
    // Parent unresolved. Fall back to the chain root when it is loaded, so the
    // child stays visibly nested instead of impersonating a top-level run.
    const root = rootOf(it);
    const loadedRoot = root ? byId.get(root) : undefined;
    detachedIds.add(it.id);
    // `rootConversationId` is the durable lineage key, but only trust a loaded
    // target that is itself a genuine root. This avoids turning a stale/corrupt
    // root id that names another child into a fabricated cross-chain edge.
    if (loadedRoot && root !== parent && !parentOf(loadedRoot)) attach(loadedRoot.id, it);
    else roots.push(it);
  }

  // Promote any node unreachable from a root (only possible under a cycle).
  const reachable = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (reachable.has(n.id)) continue;
    reachable.add(n.id);
    for (const c of childrenByParent.get(n.id) ?? []) stack.push(c);
  }
  const rootIds = new Set(roots.map((r) => r.id));
  for (const it of items) {
    if (!reachable.has(it.id) && !rootIds.has(it.id)) {
      roots.push(it);
      rootIds.add(it.id);
      // Promoted out of a cycle: its real lineage is unknown, so flag it too.
      detachedIds.add(it.id);
    }
  }

  return { roots, childrenByParent, detachedIds };
}
