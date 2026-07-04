import { Connection, Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import { mcpEdgeOptions } from '../types';
import { getConnectionError, isMcpHandle } from './connectionRules';

/** A subflow node's outgoing flow-control paths: standard edges it is the
 * source of, plus bidirectional edges pointing at it (whose reverse
 * transition it owns). Edges to/from `exceptOtherNodeId` are ignored so
 * re-draws and merges against that same node don't count as a second path. */
function subflowOutgoingEdges(
  subflowId: string,
  edges: Edge[],
  exceptOtherNodeId?: string
): Edge[] {
  const isMcp = (e: Edge) => (e.data as { edgeType?: string } | undefined)?.edgeType === 'mcp';
  return edges.filter(e => {
    if (isMcp(e)) return false;
    if (e.source === subflowId) return e.target !== exceptOtherNodeId;
    if (e.target === subflowId && (e.data as { bidirectional?: boolean } | undefined)?.bidirectional) {
      return e.source !== exceptOtherNodeId;
    }
    return false;
  });
}

/**
 * Validates if a connection between nodes is valid
 * @param params Connection parameters
 * @param nodes Array of flow nodes
 * @param edges Current edges, for rules that depend on existing connections
 * @returns Boolean indicating if the connection is valid
 */
export function validateConnection(
  params: Connection,
  nodes: FlowNode[],
  edges: Edge[] = []
): boolean {
  // Reject connections without source, target, or handles
  if (!params.source || !params.target || !params.sourceHandle || !params.targetHandle) {
    console.error('Invalid connection: Missing source, target, or handles', params);
    return false;
  }

  // Get the source and target nodes
  const sourceNode = nodes.find(node => node.id === params.source) as FlowNode | undefined;
  const targetNode = nodes.find(node => node.id === params.target) as FlowNode | undefined;

  if (!sourceNode || !targetNode) {
    console.error('Invalid connection: Source or target node not found', params);
    return false;
  }

  const error = getConnectionError(sourceNode.type, params.sourceHandle, targetNode.type, params.targetHandle);
  if (error) {
    console.error(`Invalid connection: ${error}`);
    return false;
  }

  // A subflow hands off blindly to its single successor — it has no model to
  // choose between multiple outgoing edges. Allowed shapes: one outgoing
  // edge (A > S > C) or one bidirectional edge back to the caller (A <> S).
  // Connections to the node it is already linked with are exempt: those
  // re-draw or merge rather than add a second path.
  if (sourceNode.type === 'subflow' &&
      subflowOutgoingEdges(sourceNode.id, edges, params.target).length > 0) {
    console.error('Invalid connection: Subflow nodes can only have one outgoing connection');
    return false;
  }

  return true;
}

/**
 * Creates an edge with the appropriate type and options based on the connection
 * @param params Connection parameters
 * @param nodes Array of flow nodes
 * @returns Edge object
 */
export function createEdgeFromConnection(
  params: Connection,
  nodes: FlowNode[]
): Edge {
  // Get the source and target nodes
  const sourceNode = nodes.find(node => node.id === params.source) as FlowNode | undefined;
  const targetNode = nodes.find(node => node.id === params.target) as FlowNode | undefined;
  
  // Get the source and target handles
  const sourceHandle = params.sourceHandle;
  const targetHandle = params.targetHandle;
  
  // An MCP (tool-wiring) edge links an MCP node or uses MCP handles
  const isMCPConnection =
    sourceNode?.type === 'mcp' ||
    targetNode?.type === 'mcp' ||
    isMcpHandle(sourceHandle) ||
    isMcpHandle(targetHandle);

  // The id includes the handles so two edges between the same node pair via
  // different handles never collide (colliding ids break React keys and make
  // deleting one edge remove both).
  const edgeId = `${params.source}:${sourceHandle}->${params.target}:${targetHandle}`;
  
  // Create the edge with the appropriate type and options
  if (isMCPConnection) {
    return {
      id: edgeId,
      ...params,
      type: 'mcpEdge',
      data: { edgeType: 'mcp' },
      animated: false,
      markerEnd: mcpEdgeOptions.markerEnd,
      markerStart: mcpEdgeOptions.markerStart,
      style: mcpEdgeOptions.style
    } as Edge;
  } else {
    return {
      id: edgeId,
      ...params,
      type: 'custom',
      data: { edgeType: 'standard' },
      animated: true
    } as Edge;
  }
}

/**
 * Whether an existing one-way flow edge may be upgraded to a bidirectional
 * handoff. Bidirectional means traffic also flows target -> source, so that
 * direction must be a legal connection in its own right — e.g. an edge into
 * a Finish node or out of a Start node must stay one-way. And since the
 * upgrade gives the TARGET an outgoing back-path, a subflow target must not
 * end up with a second outgoing edge (see validateConnection).
 */
export function canConvertToBidirectional(
  edge: Edge,
  nodes: FlowNode[],
  edges: Edge[] = []
): boolean {
  const sourceNode = nodes.find(node => node.id === edge.source);
  const targetNode = nodes.find(node => node.id === edge.target);
  if (!sourceNode || !targetNode) return false;
  if (targetNode.type === 'subflow' &&
      subflowOutgoingEdges(targetNode.id, edges, edge.source).length > 0) {
    return false;
  }
  return getConnectionError(targetNode.type, null, sourceNode.type, null) === null;
}

/**
 * Edges the new edge logically replaces, so a connection stays unique:
 *
 * - An MCP edge represents "this Process node is wired to this MCP server" —
 *   there must be exactly one per node pair regardless of which side or
 *   handle it was drawn from, so re-connecting on the other side moves the
 *   edge instead of doubling it.
 * - A flow-control edge is unique per direction (source -> target).
 *
 * @param newEdge The edge about to be added
 * @param edges The current edges
 * @returns The ids of existing edges to remove before adding the new one
 */
export function getReplacedEdgeIds(newEdge: Edge, edges: Edge[]): string[] {
  const isMcp = (e: Edge) => (e.data as { edgeType?: string } | undefined)?.edgeType === 'mcp';
  return edges
    .filter(e => {
      if (e.id === newEdge.id) return true;
      if (isMcp(newEdge)) {
        return isMcp(e) &&
          ((e.source === newEdge.source && e.target === newEdge.target) ||
            (e.source === newEdge.target && e.target === newEdge.source));
      }
      return !isMcp(e) && e.source === newEdge.source && e.target === newEdge.target;
    })
    .map(e => e.id);
}
