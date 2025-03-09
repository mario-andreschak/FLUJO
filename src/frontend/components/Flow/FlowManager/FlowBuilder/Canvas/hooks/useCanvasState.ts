import { useState, useEffect } from 'react';
import { useNodesState, useEdgesState, Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';

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

  // Sync with parent component when initialNodes change
  useEffect(() => {
    if (initialNodes !== nodes) {
      setNodes(initialNodes);
    }
  }, [initialNodes, setNodes, nodes]);
  
  // Sync with parent component when initialEdges change
  useEffect(() => {
    if (initialEdges !== edges) {
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
