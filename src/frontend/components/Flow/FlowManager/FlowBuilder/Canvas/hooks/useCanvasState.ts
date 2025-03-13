import { useState, useEffect } from 'react';
import { useNodesState, useEdgesState, Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('components/flow/FlowBuilder/Canvas/hooks/useCanvasState.ts');

/**
 * Custom hook to manage canvas state (nodes and edges)
 * @param initialNodes Initial nodes array
 * @param initialEdges Initial edges array
 * @returns Object containing state and state management functions
 */
export function useCanvasState(initialNodes: FlowNode[], initialEdges: Edge[]) {
  // Use ReactFlow's state hooks
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  
  // Track the last added edge for notifying parent
  const [lastAddedEdge, setLastAddedEdge] = useState<Edge | null>(null);
  
  // Log when lastAddedEdge changes
  useEffect(() => {
    if (lastAddedEdge) {
      log.debug(`useCanvasState: Last added edge set - ${lastAddedEdge.id} from ${lastAddedEdge.source} to ${lastAddedEdge.target}`);
    }
  }, [lastAddedEdge]);

  // Sync with parent component when initialNodes change
  useEffect(() => {
    if (initialNodes !== nodes) {
      log.debug(`useCanvasState: Syncing ${initialNodes.length} nodes from parent component`);
      setNodes(initialNodes);
    }
  }, [initialNodes, setNodes, nodes]);
  
  // Sync with parent component when initialEdges change
  useEffect(() => {
    if (initialEdges !== edges) {
      log.debug(`useCanvasState: Syncing ${initialEdges.length} edges from parent component`);
      setEdges(initialEdges);
    }
  }, [initialEdges, setEdges, edges]);

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    lastAddedEdge,
    setLastAddedEdge
  };
}

export default useCanvasState;
