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
}

/**
 * Build the chain index for a set of conversations.
 *
 * A conversation is a ROOT when:
 *  - it has no `parentConversationId`, OR
 *  - its parent isn't present in this set (a filter hid it, or the parent was
 *    deleted) — so a matched child never silently disappears, and
 *  - (defensively) its parent link points at itself.
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

  const parentOf = (it: ConversationListItem): string | null =>
    it.parentConversationId && it.parentConversationId !== it.id ? it.parentConversationId : null;

  for (const it of items) {
    const parent = parentOf(it);
    if (parent && byId.has(parent)) {
      const arr = childrenByParent.get(parent) ?? [];
      arr.push(it);
      childrenByParent.set(parent, arr);
    } else {
      roots.push(it);
    }
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
    }
  }

  return { roots, childrenByParent };
}
