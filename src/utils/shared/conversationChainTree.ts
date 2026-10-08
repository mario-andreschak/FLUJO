/**
 * Pure hierarchy adapter for Chain Chat.
 *
 * Chain Chat is deliberately rendered as a semantic, top-down DOM tree.  This
 * adapter reuses the same ancestry rules as the chat sidebar, but exposes a
 * recursive model instead of canvas coordinates.  The visited guards make
 * malformed parent cycles degrade to a small forest without hiding nodes or
 * recursing forever.
 */

import type { ConversationListItem } from '@/frontend/components/Chat';
import type { ConversationChainNode } from '@/shared/types/conversationChain';
import { buildChainIndex } from './conversationChains';

export const MAX_CHAIN_TREE_DEPTH = 24;

export interface ConversationChainTreeNode {
  id: string;
  depth: number;
  detached: boolean;
  conversation: ConversationChainNode;
  children: ConversationChainTreeNode[];
}

export interface ConversationChainTreeModel {
  roots: ConversationChainTreeNode[];
  detachedIds: string[];
}

/** The subset of ConversationListItem consumed by buildChainIndex(). */
function toChainItem(node: ConversationChainNode): ConversationListItem {
  return {
    id: node.id,
    title: node.title,
    flowId: null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    ...(node.status ? { status: node.status } : {}),
    parentConversationId: node.parentConversationId,
    rootConversationId: node.rootConversationId,
  } as ConversationListItem;
}

/**
 * Convert a flat, bounded chain projection into a stable recursive forest.
 * Every input node is returned exactly once.
 */
export function buildConversationChainTree(
  nodes: ConversationChainNode[],
  maxDepth: number = MAX_CHAIN_TREE_DEPTH,
): ConversationChainTreeModel {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { roots: [], detachedIds: [] };
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const { roots, childrenByParent, detachedIds } = buildChainIndex(nodes.map(toChainItem));
  const rendered = new Set<string>();

  const build = (
    id: string,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): ConversationChainTreeNode | null => {
    if (rendered.has(id)) return null;
    const conversation = byId.get(id);
    if (!conversation) return null;

    rendered.add(id);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(id);

    const children: ConversationChainTreeNode[] = [];
    if (depth < Math.max(0, maxDepth)) {
      for (const child of childrenByParent.get(id) ?? []) {
        if (nextAncestors.has(child.id)) continue;
        const branch = build(child.id, depth + 1, nextAncestors);
        if (branch) children.push(branch);
      }
    }

    return {
      id,
      depth,
      detached: detachedIds.has(id),
      conversation,
      children,
    };
  };

  const treeRoots: ConversationChainTreeNode[] = [];
  for (const root of roots) {
    const branch = build(root.id, 0, new Set());
    if (branch) treeRoots.push(branch);
  }

  // Defensive fallback for nodes below the depth cap or otherwise unreachable
  // in malformed input. They remain visible as detached roots.
  for (const node of nodes) {
    if (rendered.has(node.id)) continue;
    detachedIds.add(node.id);
    const branch = build(node.id, 0, new Set());
    if (branch) treeRoots.push(branch);
  }

  return { roots: treeRoots, detachedIds: [...detachedIds] };
}

/** True when this branch currently contains live work. */
export function chainBranchIsActive(node: ConversationChainTreeNode): boolean {
  return node.conversation.active || node.children.some(chainBranchIsActive);
}
