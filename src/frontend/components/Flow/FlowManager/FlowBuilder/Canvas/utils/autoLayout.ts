import { Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import {
  isAttachmentEdge,
  isMcpEdge,
  isResourceEdge,
  nodeSize,
  resolveSatelliteParents,
} from './layoutGeometry';
import { computeTidyLayout } from './tidyLayout';

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
  /** Vertical gap between stacked MCP/resource siblings on one process node.
   *  Default 120 (matches `handleConnectMcpServer`). */
  mcpStackY?: number;
}

/**
 * Compute a clean layered layout for a flow ("Re-layout top-to-bottom",
 * issue #373 / #100). This is a DESTRUCTIVE full re-layout: it discards
 * existing coordinates (besides using them to keep a stable reading order)
 * and repacks the graph from scratch. For a layout that keeps the user's
 * existing arrangement and only resolves collisions, see `computeTidyLayout`.
 *
 * Pure geometry: only `position` fields change. `id`, `type`, `data`,
 * `selected` and the edges array are all left untouched, and a brand-new node
 * array is returned so callers (e.g. `setNodes`) treat it as an undoable edit.
 *
 * Approach (dependency-free longest-path layering):
 *  1. Split nodes/edges into flow-control vs. MCP/resource satellites.
 *  2. Rank the flow nodes by longest path from the roots (nodes with no
 *     incoming flow edge, e.g. Start), so the graph reads top-to-bottom.
 *     Bidirectional edges keep their source->target direction and are not
 *     double-counted; cycles are handled with a bounded relaxation so a
 *     looping handoff can never hang the layout.
 *  3. Spread nodes horizontally within each rank, in the user's current
 *     left-to-right order, reserving a lane for each node's attached
 *     satellites so siblings never collide with them (issue #373 B1).
 *  4. Park each MCP node to the right (resource node to the left) of the flow
 *     node it is wired to, stacking siblings by measured height (B2). Any
 *     satellite left unattached (no resolvable parent) is relocated to a
 *     dedicated lane beside the packed graph instead of keeping a stale,
 *     possibly-colliding position (B5).
 *  5. Run a final tidy/relaxation pass as a safety net so the "no two nodes
 *     overlap" invariant holds even for unusual measured sizes.
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
  // Resource nodes (Tier 3) are satellites like MCP nodes — parked beside
  // their process node (left side, mirroring MCP on the right).
  const resourceNodes = nodes.filter(n => n.type === 'resource');
  const flowNodes = nodes.filter(n => n.type !== 'mcp' && n.type !== 'resource');

  // Nothing meaningful to arrange.
  if (flowNodes.length <= 1) {
    return nodes;
  }

  const flowIds = new Set(flowNodes.map(n => n.id));

  // Build the flow-control adjacency, deduped per direction.
  const adjacency = new Map<string, Set<string>>();
  flowNodes.forEach(n => adjacency.set(n.id, new Set<string>()));

  for (const edge of edges) {
    if (isAttachmentEdge(edge)) continue;
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

  // Resolve each satellite's parent up-front so its footprint can be reserved
  // during packing (B1) and its stack extent counted into rank spacing (B2).
  // A parent must be a flow node that will actually be laid out.
  const resolveParents = (satellites: FlowNode[], isSatEdge: (e: Edge) => boolean) => {
    const map = resolveSatelliteParents(satellites, edges, isSatEdge);
    for (const [satId, flowId] of [...map]) {
      if (!flowIds.has(flowId)) map.delete(satId);
    }
    return map;
  };
  const mcpParent = resolveParents(mcpNodes, isMcpEdge);
  const resourceParent = resolveParents(resourceNodes, isResourceEdge);

  const groupByParent = (satellites: FlowNode[], parent: Map<string, string>) => {
    const byParent = new Map<string, FlowNode[]>();
    for (const sat of satellites) {
      const parentId = parent.get(sat.id);
      if (!parentId) continue;
      const bucket = byParent.get(parentId);
      if (bucket) bucket.push(sat);
      else byParent.set(parentId, [sat]);
    }
    return byParent;
  };
  const mcpByParent = groupByParent(mcpNodes, mcpParent);
  const resourceByParent = groupByParent(resourceNodes, resourceParent);

  // A flow node's satellite lane extent, in absolute distance from the flow
  // node's own top-left corner: how far the MCP stack reaches to the right,
  // how far the resource stack reaches to the left, and how tall either
  // stack grows (so the next rank clears it).
  const laneExtent = (node: FlowNode) => {
    const mcps = mcpByParent.get(node.id) ?? [];
    const resources = resourceByParent.get(node.id) ?? [];
    const stackHeight = (sats: FlowNode[]) =>
      sats.length === 0
        ? 0
        : sats.reduce((sum, s) => sum + nodeSize(s).height, 0) + (sats.length - 1) * mcpStackY;
    const maxWidth = (sats: FlowNode[]) => (sats.length === 0 ? 0 : Math.max(...sats.map(s => nodeSize(s).width)));
    return {
      rightReach: mcps.length === 0 ? 0 : mcpOffsetX + maxWidth(mcps),
      leftReach: resources.length === 0 ? 0 : mcpOffsetX,
      stackHeight: Math.max(stackHeight(mcps), stackHeight(resources)),
    };
  };

  // Group nodes by rank. Within a rank, order by the user's current x/y (then
  // id) rather than raw array order (B4), so a hand-arranged left-to-right
  // reading order survives a re-layout instead of following insertion order.
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
    const rankNodes = [...ranks.get(key)!].sort(
      (a, b) => a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id)
    );
    let across = 0;
    let maxAlongSize = 0;
    for (const node of rankNodes) {
      const { width, height } = nodeSize(node);
      const lane = laneExtent(node);
      if (direction === 'TB') {
        across += lane.leftReach;
        positions.set(node.id, { x: across, y: along });
        across += Math.max(width, lane.rightReach) + nodeSep;
        maxAlongSize = Math.max(maxAlongSize, height, lane.stackHeight);
      } else {
        across += lane.leftReach;
        positions.set(node.id, { x: along, y: across });
        across += Math.max(height, lane.rightReach) + nodeSep;
        maxAlongSize = Math.max(maxAlongSize, width, lane.stackHeight);
      }
    }
    along += maxAlongSize + rankSep;
  }

  // Park each satellite beside its parent, stacking siblings by their
  // measured (or fallback) height plus `mcpStackY` gap — not a flat
  // `index * mcpStackY`, which is what let a tall MCP node punch into the
  // next rank (B2). MCP nodes go right; resource nodes mirror to the left.
  const parkSatellites = (byParent: Map<string, FlowNode[]>, offsetSign: 1 | -1) => {
    for (const [parentId, satellites] of byParent) {
      const parentPos = positions.get(parentId);
      if (!parentPos) continue;
      let y = parentPos.y;
      for (const satNode of satellites) {
        positions.set(satNode.id, { x: parentPos.x + offsetSign * mcpOffsetX, y });
        y += nodeSize(satNode).height + mcpStackY;
      }
    }
  };
  parkSatellites(mcpByParent, 1);
  parkSatellites(resourceByParent, -1);

  // Unattached satellites (no resolvable parent) are relocated to a lane
  // beside the packed graph instead of keeping a stale position that may now
  // overlap the fresh layout (B5).
  const packedXs = [...positions.values()].map(p => p.x);
  const rightLaneX = packedXs.length ? Math.max(...packedXs) + mcpOffsetX : 0;
  let leftoverY = 0;
  const sweepLeftovers = (satellites: FlowNode[]) => {
    for (const sat of satellites) {
      if (positions.has(sat.id)) continue;
      positions.set(sat.id, { x: rightLaneX, y: leftoverY });
      leftoverY += nodeSize(sat).height + nodeSep;
    }
  };
  sweepLeftovers(mcpNodes);
  sweepLeftovers(resourceNodes);

  const packed = nodes.map(node => {
    const pos = positions.get(node.id);
    return pos ? { ...node, position: pos } : node;
  });

  // Final safety net (G1): the packing above should already be collision
  // free, but unusual measured sizes could still slip through — a bounded
  // tidy pass over the packed result guarantees the invariant regardless,
  // and is a no-op when the packing is already clean.
  return computeTidyLayout(packed, edges, { preserveCentroid: false, snapToGrid: false });
}
