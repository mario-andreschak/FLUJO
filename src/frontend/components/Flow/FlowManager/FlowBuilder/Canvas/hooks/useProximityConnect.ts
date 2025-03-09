import { useCallback } from 'react';
import { useStoreApi, useReactFlow, Node, Edge } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import { MIN_DISTANCE, defaultEdgeOptions, mcpEdgeOptions } from '../types';

/**
 * Custom hook to handle proximity connections between nodes
 * @param nodes Array of flow nodes
 * @param setEdges Function to update edges
 * @param setLastAddedEdge Function to set the last added edge
 * @param onEdgesChangeCallback Optional callback for edge changes
 * @returns Object containing proximity connection handlers
 */
export function useProximityConnect(
  nodes: FlowNode[],
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>,
  setLastAddedEdge: React.Dispatch<React.SetStateAction<Edge | null>>,
  onEdgesChangeCallback?: (changes: any) => void
) {
  const store = useStoreApi();
  const { getInternalNode } = useReactFlow();

  // Function to find the closest node to a dragged node
  const getClosestEdge = useCallback((node: Node) => {
    const { nodeLookup } = store.getState();
    const internalNode = getInternalNode(node.id);
    
    if (!internalNode) return null;
    
    const closestNode = Array.from(nodeLookup.values()).reduce(
      (res: { distance: number; node: any | null }, n: any) => {
        if (n.id !== internalNode.id && n.internals && internalNode.internals) {
          const dx = n.internals.positionAbsolute.x - internalNode.internals.positionAbsolute.x;
          const dy = n.internals.positionAbsolute.y - internalNode.internals.positionAbsolute.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          
          if (d < res.distance && d < MIN_DISTANCE) {
            res.distance = d;
            res.node = n;
          }
        }
        
        return res;
      },
      {
        distance: Number.MAX_VALUE,
        node: null,
      }
    );
    
    if (!closestNode.node || !internalNode.internals) {
      return null;
    }
    
    const closeNodeIsSource = 
      closestNode.node.internals.positionAbsolute.x < internalNode.internals.positionAbsolute.x;
    
    return {
      id: closeNodeIsSource
        ? `${closestNode.node.id}-${node.id}`
        : `${node.id}-${closestNode.node.id}`,
      source: closeNodeIsSource ? closestNode.node.id : node.id,
      target: closeNodeIsSource ? node.id : closestNode.node.id,
    };
  }, [getInternalNode, store]);
  
  // Handle node drag to show temporary connections
  const onNodeDrag = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const closeEdge = getClosestEdge(node);
      
      setEdges((es) => {
        const nextEdges = es.filter((e) => e.className !== 'temp');
        
        if (
          closeEdge &&
          !nextEdges.find(
            (ne) => ne.source === closeEdge.source && ne.target === closeEdge.target
          )
        ) {
          const tempEdge: Edge = {
            ...closeEdge,
            className: 'temp',
            style: { 
              ...defaultEdgeOptions.style,
              stroke: 'rgba(85, 85, 85, 0.5)', // More transparent version of the default edge color
              strokeDasharray: '5,5', // Dotted line
            }
          };
          nextEdges.push(tempEdge);
        }
        
        return nextEdges;
      });
    },
    [getClosestEdge, setEdges]
  );
  
  // Handle node drag stop to create permanent connections
  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const closeEdge = getClosestEdge(node);
      
      setEdges((es) => {
        const nextEdges = es.filter((e) => e.className !== 'temp');
        
        if (
          closeEdge &&
          !nextEdges.find(
            (ne) => ne.source === closeEdge.source && ne.target === closeEdge.target
          )
        ) {
          // Create a permanent edge with the appropriate type
          const sourceNode = nodes.find(n => n.id === closeEdge.source) as FlowNode | undefined;
          const targetNode = nodes.find(n => n.id === closeEdge.target) as FlowNode | undefined;
          
          if (!sourceNode || !targetNode) return nextEdges;
          
          // Determine if this should be an MCP edge
          const isMCPConnection = 
            (sourceNode.type === 'mcp' && targetNode.type === 'process') ||
            (sourceNode.type === 'process' && targetNode.type === 'mcp');
          
          let newEdge: Edge;
          
          if (isMCPConnection) {
            newEdge = {
              ...closeEdge,
              type: 'mcpEdge',
              data: { edgeType: 'mcp' },
              animated: false,
              markerEnd: mcpEdgeOptions.markerEnd,
              markerStart: mcpEdgeOptions.markerStart,
              style: mcpEdgeOptions.style
            };
          } else {
            newEdge = {
              ...closeEdge,
              type: 'custom',
              data: { edgeType: 'standard' },
              animated: true
            };
          }
          
          nextEdges.push(newEdge);
          
          // Notify parent about the new edge
          if (onEdgesChangeCallback) {
            setLastAddedEdge(newEdge);
          }
        }
        
        return nextEdges;
      });
    },
    [getClosestEdge, setEdges, nodes, onEdgesChangeCallback, setLastAddedEdge]
  );

  return {
    getClosestEdge,
    onNodeDrag,
    onNodeDragStop
  };
}

export default useProximityConnect;
