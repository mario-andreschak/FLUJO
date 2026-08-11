import type { DebugBoundary } from '@/backend/execution/flow/types';

export interface DebugBoundaryGraphEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * Resolve a debugger boundary to authored graph edge ids without depending on
 * React Flow. Graph transitions name their control edge directly (including a
 * target node's BEFORE boundary after stepping through Start). Tool boundaries
 * name the MCP nodes that advertised the calls, so match the wiring between
 * the active Process node and each of those nodes.
 */
export function debugBoundaryEdgeIds(
  boundary: DebugBoundary | undefined,
  edges: readonly DebugBoundaryGraphEdge[],
): Set<string> {
  if (!boundary) return new Set();

  if (boundary.edgeId) {
    return new Set(edges.some(edge => edge.id === boundary.edgeId) ? [boundary.edgeId] : []);
  }

  if (boundary.operation !== 'tool' || !boundary.toolNodeIds?.length) return new Set();

  const toolNodes = new Set(boundary.toolNodeIds);
  return new Set(edges.filter(edge => {
    const joinsCurrentNode = !boundary.nodeId
      || edge.source === boundary.nodeId
      || edge.target === boundary.nodeId;
    const joinsToolNode = toolNodes.has(edge.source) || toolNodes.has(edge.target);
    return joinsCurrentNode && joinsToolNode;
  }).map(edge => edge.id));
}
