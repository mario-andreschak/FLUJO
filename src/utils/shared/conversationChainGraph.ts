/**
 * Pure graph adapter for the chain-chat canvas (issue #405).
 *
 * The renderer needs flat nodes + edges with positions; ancestry rules already
 * live in `buildChainIndex()` (missing parents, stale roots, self-links,
 * cycles, empty input). This module reuses that index rather than duplicating
 * the rules inside the UI, then lays the result out as a deterministic tidy
 * tree: one row per node in depth-first order, one column per depth.
 *
 * Pure and framework-free so it can be unit-tested without React/React Flow.
 */

import type { ConversationListItem } from '@/frontend/components/Chat';
import type { ConversationChainNode } from '@/shared/types/conversationChain';
import { buildChainIndex } from './conversationChains';

export const CHAIN_NODE_WIDTH = 288;
export const CHAIN_NODE_HEIGHT = 136;
export const CHAIN_COLUMN_GAP = 88;
export const CHAIN_ROW_GAP = 28;

export interface ChainGraphNode {
  id: string;
  /** Distance from the chain root; drives the x column. */
  depth: number;
  position: { x: number; y: number };
  /** True when the node's real parent could not be resolved in this set. */
  detached: boolean;
  conversation: ConversationChainNode;
}

export interface ChainGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface ChainGraphModel {
  nodes: ChainGraphNode[];
  edges: ChainGraphEdge[];
  detachedIds: string[];
}

/** The subset of `ConversationListItem` `buildChainIndex()` actually reads. */
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
 * Build positioned nodes and directed parent→child edges for one chain.
 * Traversal is visited-guarded, so even a corrupt (cyclic) parent set
 * terminates and degrades to extra roots instead of looping.
 */
export function buildChainGraphModel(nodes: ConversationChainNode[]): ChainGraphModel {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { nodes: [], edges: [], detachedIds: [] };
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const { roots, childrenByParent, detachedIds } = buildChainIndex(nodes.map(toChainItem));

  const graphNodes: ChainGraphNode[] = [];
  const edges: ChainGraphEdge[] = [];
  const visited = new Set<string>();
  let row = 0;

  const place = (id: string, depth: number): void => {
    const conversation = byId.get(id);
    if (!conversation) return;
    graphNodes.push({
      id,
      depth,
      position: {
        x: depth * (CHAIN_NODE_WIDTH + CHAIN_COLUMN_GAP),
        y: row * (CHAIN_NODE_HEIGHT + CHAIN_ROW_GAP),
      },
      detached: detachedIds.has(id),
      conversation,
    });
    row += 1;
  };

  const walk = (id: string, depth: number): void => {
    if (visited.has(id)) return;
    visited.add(id);
    place(id, depth);
    for (const child of childrenByParent.get(id) ?? []) {
      if (visited.has(child.id)) continue;
      edges.push({ id: `${id}->${child.id}`, source: id, target: child.id });
      walk(child.id, depth + 1);
    }
  };

  for (const root of roots) walk(root.id, 0);

  // Defensive: nothing may disappear from the canvas, whatever the input.
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    place(node.id, 0);
  }

  return { nodes: graphNodes, edges, detachedIds: [...detachedIds] };
}
