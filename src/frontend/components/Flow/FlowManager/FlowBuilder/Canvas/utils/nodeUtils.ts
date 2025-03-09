import { FlowNode } from '@/frontend/types/flow/flow';
import { NodeChange, EdgeChange } from '@xyflow/react';

/**
 * Generates changes for deleting nodes and their connected edges
 * @param selectedNodeIds Array of selected node IDs
 * @param selectedEdgeIds Array of selected edge IDs
 * @param nodes Array of flow nodes
 * @param edges Array of edges
 * @returns Object containing node and edge changes
 */
export function getDeleteChanges(
  selectedNodeIds: string[],
  selectedEdgeIds: string[],
  nodes: FlowNode[],
  edges: any[]
): { nodeChanges: NodeChange<FlowNode>[], edgeChanges: EdgeChange[] } {
  // Filter out Start nodes - they cannot be deleted
  const deletableNodeIds = selectedNodeIds.filter(nodeId => {
    const node = nodes.find(n => n.id === nodeId);
    return node && node.type !== 'start'; // Only include nodes that are not Start nodes
  });
  
  // Create node changes for deletion
  const nodeChanges: NodeChange<FlowNode>[] = deletableNodeIds.map(nodeId => ({
    type: 'remove',
    id: nodeId,
  }));

  // Find all edges connected to the selected nodes
  const connectedEdges = edges.filter(edge => 
    selectedNodeIds.includes(edge.source) || 
    selectedNodeIds.includes(edge.target)
  );
  
  // Create edge changes for deletion (both selected edges and connected edges)
  const edgeChanges: EdgeChange[] = [
    ...selectedEdgeIds.map(edgeId => ({
      type: 'remove' as const,
      id: edgeId,
    })),
    ...connectedEdges
      .filter(edge => !selectedEdgeIds.includes(edge.id)) // Avoid duplicates
      .map(edge => ({
        type: 'remove' as const,
        id: edge.id,
      }))
  ];

  return { nodeChanges, edgeChanges };
}

/**
 * Finds a node by its ID
 * @param nodeId Node ID to find
 * @param nodes Array of flow nodes
 * @returns The found node or undefined
 */
export function findNodeById(nodeId: string, nodes: FlowNode[]): FlowNode | undefined {
  return nodes.find(node => node.id === nodeId);
}

/**
 * Checks if a node can be deleted
 * @param nodeId Node ID to check
 * @param nodes Array of flow nodes
 * @returns Boolean indicating if the node can be deleted
 */
export function canDeleteNode(nodeId: string, nodes: FlowNode[]): boolean {
  const node = findNodeById(nodeId, nodes);
  // Start nodes cannot be deleted
  return node ? node.type !== 'start' : false;
}
