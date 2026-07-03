import { FlowNode } from '@/frontend/types/flow/flow';

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
