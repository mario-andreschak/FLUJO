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
  
  // Generate a unique ID for the edge
  const edgeId = `${params.source}-${params.target}`;
  
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
