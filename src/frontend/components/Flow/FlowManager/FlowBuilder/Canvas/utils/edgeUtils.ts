import { Connection, Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import { mcpEdgeOptions } from '../types';

/**
 * Validates if a connection between nodes is valid
 * @param params Connection parameters
 * @param nodes Array of flow nodes
 * @returns Boolean indicating if the connection is valid
 */
export function validateConnection(
  params: Connection,
  nodes: FlowNode[]
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
  
  // Reject connections from Finish nodes (they should only have incoming connections)
  if (sourceNode.type === 'finish') {
    console.error('Invalid connection: Finish nodes cannot have outgoing connections');
    return false;
  }
  
  // Reject connections to Start nodes (they should only have outgoing connections)
  if (targetNode.type === 'start') {
    console.error('Invalid connection: Start nodes cannot have incoming connections');
    return false;
  }
  
  // Check if one is an MCP node and the other is a PROCESS node
  const isMCPToProcess = 
    (sourceNode.type === 'mcp' && targetNode.type === 'process') ||
    (sourceNode.type === 'process' && targetNode.type === 'mcp');
  
  // Check if the connection involves MCP handles
  const isMCPConnection = 
    (params.sourceHandle?.includes('mcp') || params.targetHandle?.includes('mcp')) ||
    (params.sourceHandle?.includes('left') || params.sourceHandle?.includes('right')) ||
    (params.targetHandle?.includes('left') || params.targetHandle?.includes('right'));
  
  // Validate MCP connections
  if (sourceNode.type === 'mcp' || targetNode.type === 'mcp') {
    // If an MCP node is involved, ensure it's connecting to a PROCESS node's MCP edge
    if (!isMCPToProcess || !isMCPConnection) {
      console.error('Invalid connection: MCP nodes can only connect to Process nodes via MCP handles');
      return false;
    }
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
  
  // Check if the connection involves MCP handles
  const isMCPConnection =
    (sourceHandle?.includes('mcp') || targetHandle?.includes('mcp')) ||
    (sourceHandle?.includes('left') || sourceHandle?.includes('right')) ||
    (targetHandle?.includes('left') || targetHandle?.includes('right')) ||
    (sourceNode?.type === 'mcp' || targetNode?.type === 'mcp');

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
