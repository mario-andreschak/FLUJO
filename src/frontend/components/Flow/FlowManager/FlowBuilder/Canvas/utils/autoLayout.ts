import { Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';

/**
 * Options for {@link computeAutoLayout}. All are optional; the defaults produce
 * a tidy top-to-bottom flow with MCP nodes parked to the right of their
 * process node (matching the placement convention in `handleConnectMcpServer`).
 */
export interface AutoLayoutOptions {
  /** Primary flow direction. Flow handles are vertical (top = target, bottom =
   *  source), so the natural reading order is top-to-bottom. Default `'TB'`. */
  direction?: 'TB' | 'LR';
  /** Gap between successive ranks along the flow direction. Default 120. */
  rankSep?: number;
  /** Gap between sibling nodes within the same rank. Default 80. */
  nodeSep?: number;
  /** Horizontal offset of an MCP node from its process node. Default 350
   *  (matches `handleConnectMcpServer`). */
  mcpOffsetX?: number;
  /** Vertical spacing when several MCP nodes stack on one process node.
   *  Default 120 (matches `handleConnectMcpServer`). */
  mcpStackY?: number;
}

// Fallback dimensions for nodes React Flow has not measured yet (e.g. a freshly
// generated flow that has never been rendered). Roughly the rendered size of a
// CustomNode.
const DEFAULT_WIDTH = 240;
const DEFAULT_HEIGHT = 80;

function nodeSize(node: FlowNode): { width: number; height: number } {
  const measured = (node as { measured?: { width?: number; height?: number } }).measured;
  const width = measured?.width ?? (node as { width?: number }).width ?? DEFAULT_WIDTH;
  const height = measured?.height ?? (node as { height?: number }).height ?? DEFAULT_HEIGHT;
  return { width, height };
}

function isMcpEdge(edge: Edge): boolean {
  return (edge.data as { edgeType?: string } | undefined)?.edgeType === 'mcp';
}

/**
 * Compute a clean layered layout for a flow.
 *
 * Pure geometry: only `position` fields change. `id`, `type`, `data`,
 * `selected` and the edges array are all left untouched, and a brand-new node
 * array is returned so callers (e.g. `setNodes`) treat it as an undoable edit.
 *
 * Approach (dependency-free longest-path layering):
 *  1. Split nodes/edges into flow-control vs. MCP.
 *  2. Rank the flow nodes by longest path from the roots (nodes with no
 *     incoming flow edge, e.g. Start), so the graph reads top-to-bottom.
 *     Bidirectional edges keep their source->target direction and are not
 *     double-counted; cycles are handled with a bounded relaxation so a
 *     looping handoff can never hang the layout.
 *  3. Spread nodes horizontally within each rank.
 *  4. Park each MCP node to the right of the flow node it is wired to,
 *     stacking siblings downward.
 *
 * A flow with 0 or 1 flow nodes is returned unchanged (nothing to arrange).
 */
export function computeAutoLayout(
  nodes: FlowNode[],
  edges: Edge[],
  options: AutoLayoutOptions = {}
): FlowNode[] {
  const {
    direction = 'TB',
    rankSep = 120,
    nodeSep = 80,
    mcpOffsetX = 350,
    mcpStackY = 120,
  } = options;

  const mcpNodes = nodes.filter(n => n.type === 'mcp');
  const flowNodes = nodes.filter(n => n.type !== 'mcp');

  // Nothing meaningful to arrange.
  if (flowNodes.length <= 1) {
    return nodes;
  }

  const flowIds = new Set(flowNodes.map(n => n.id));

  // Build the flow-control adjacency, deduped per direction.
  const adjacency = new Map<string, Set<string>>();
  flowNodes.forEach(n => adjacency.set(n.id, new Set<string>()));

  for (const edge of edges) {
    if (isMcpEdge(edge)) continue;
    if (edge.source === edge.target) continue;
    if (!flowIds.has(edge.source) || !flowIds.has(edge.target)) continue;
    adjacency.get(edge.source)!.add(edge.target);
  }

  // Longest-path layering via bounded relaxation. Every node starts at rank 0
  // (so isolated nodes and true roots stay at the top); each edge pushes its
  // target to at least source + 1. The iteration cap (node count) guarantees
  // termination even when bidirectional/looping edges form a cycle.
  const rank = new Map<string, number>();
  flowNodes.forEach(n => rank.set(n.id, 0));

  const maxIterations = flowNodes.length;
  for (let i = 0; i < maxIterations; i++) {
    let changed = false;
    for (const [source, targets] of adjacency) {
      const nextRank = rank.get(source)! + 1;
      for (const target of targets) {
        if (rank.get(target)! < nextRank) {
          rank.set(target, nextRank);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // Group nodes by rank, preserving their original array order within a rank
  // for a stable, deterministic layout.
  const ranks = new Map<number, FlowNode[]>();
  for (const node of flowNodes) {
    const r = rank.get(node.id)!;
    const bucket = ranks.get(r);
    if (bucket) bucket.push(node);
    else ranks.set(r, [node]);
  }
  const sortedRankKeys = [...ranks.keys()].sort((a, b) => a - b);

  const positions = new Map<string, { x: number; y: number }>();

  // `along` walks the flow direction (y for TB, x for LR); `across` spreads
  // siblings within a rank (x for TB, y for LR).
  let along = 0;
  for (const key of sortedRankKeys) {
    const rankNodes = ranks.get(key)!;
    let across = 0;
    let maxAlongSize = 0;
    for (const node of rankNodes) {
      const { width, height } = nodeSize(node);
      if (direction === 'TB') {
        positions.set(node.id, { x: across, y: along });
        across += width + nodeSep;
        maxAlongSize = Math.max(maxAlongSize, height);
      } else {
        positions.set(node.id, { x: along, y: across });
        across += height + nodeSep;
        maxAlongSize = Math.max(maxAlongSize, width);
      }
    }
    along += maxAlongSize + rankSep;
  }

  // Map each MCP node to the single flow node it is wired to (first such edge
  // wins), then park it to the right and stack siblings downward.
  const mcpIds = new Set(mcpNodes.map(n => n.id));
  const mcpParent = new Map<string, string>();
  for (const edge of edges) {
    if (!isMcpEdge(edge)) continue;
    const sourceIsMcp = mcpIds.has(edge.source);
    const targetIsMcp = mcpIds.has(edge.target);
    let mcpId: string | undefined;
    let flowId: string | undefined;
    if (sourceIsMcp && !targetIsMcp) {
      mcpId = edge.source;
      flowId = edge.target;
    } else if (targetIsMcp && !sourceIsMcp) {
      mcpId = edge.target;
      flowId = edge.source;
    }
    if (mcpId && flowId && positions.has(flowId) && !mcpParent.has(mcpId)) {
      mcpParent.set(mcpId, flowId);
    }
  }

  const stackCount = new Map<string, number>();
  for (const mcpNode of mcpNodes) {
    const parentId = mcpParent.get(mcpNode.id);
    if (!parentId) continue; // Unattached MCP node keeps its current position.
    const parentPos = positions.get(parentId)!;
    const index = stackCount.get(parentId) ?? 0;
    stackCount.set(parentId, index + 1);
    positions.set(mcpNode.id, {
      x: parentPos.x + mcpOffsetX,
      y: parentPos.y + index * mcpStackY,
    });
  }

  // Return a new array; only positions we computed are replaced.
  return nodes.map(node => {
    const pos = positions.get(node.id);
    return pos ? { ...node, position: pos } : node;
  });
}
