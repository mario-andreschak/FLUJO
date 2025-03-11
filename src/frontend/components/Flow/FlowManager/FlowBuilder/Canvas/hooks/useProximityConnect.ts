import { useCallback } from 'react';
import { useStoreApi, useReactFlow, Node, Edge, Position } from '@xyflow/react';
import { FlowNode } from '@/frontend/types/flow/flow';
import { MIN_DISTANCE, defaultEdgeOptions, mcpEdgeOptions } from '../types';
import { validateConnection, createEdgeFromConnection } from '../utils/edgeUtils';

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
  const { getInternalNode, getNodes, setNodes } = useReactFlow();

  // Function to find the closest valid connection between nodes
  const getClosestEdge = useCallback((node: Node) => {
    const { nodeLookup } = store.getState();
    const internalNode = getInternalNode(node.id);
    
    if (!internalNode) return null;
    
    // Get the dragged node's data
    const draggedNodeData = nodes.find(n => n.id === node.id) as FlowNode | undefined;
    if (!draggedNodeData) return null;
    
    // Find the closest node
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
    
    // Get the closest node's data
    const closestNodeData = nodes.find(n => n.id === closestNode.node.id) as FlowNode | undefined;
    if (!closestNodeData) return null;
    
    // Get node positions for handle selection
    const draggedNodePos = {
      x: internalNode.internals.positionAbsolute.x + (node.width || 0) / 2,
      y: internalNode.internals.positionAbsolute.y + (node.height || 0) / 2
    };
    
    const closestNodePos = {
      x: closestNode.node.internals.positionAbsolute.x + (closestNode.node.width || 0) / 2,
      y: closestNode.node.internals.positionAbsolute.y + (closestNode.node.height || 0) / 2
    };
    
    // Try both connection directions and find the valid one
    let validConnection = null;
    
    // Try dragged node as source, closest node as target
    if (isValidSourceNode(draggedNodeData.type || '') && isValidTargetNode(closestNodeData.type || '')) {
      const sourceHandle = getSourceHandle(
        draggedNodeData.type || '', 
        closestNodeData.type || '', 
        draggedNodePos, 
        closestNodePos
      );
      const targetHandle = getTargetHandle(
        closestNodeData.type || '', 
        draggedNodeData.type || '', 
        draggedNodePos, 
        closestNodePos
      );
      
      const connection = {
        source: node.id,
        target: closestNode.node.id,
        sourceHandle,
        targetHandle
      };
      
      if (validateConnection(connection, nodes)) {
        validConnection = connection;
      }
    }
    
    // If no valid connection found, try closest node as source, dragged node as target
    if (!validConnection && isValidSourceNode(closestNodeData.type || '') && isValidTargetNode(draggedNodeData.type || '')) {
      const sourceHandle = getSourceHandle(
        closestNodeData.type || '', 
        draggedNodeData.type || '', 
        closestNodePos, 
        draggedNodePos
      );
      const targetHandle = getTargetHandle(
        draggedNodeData.type || '', 
        closestNodeData.type || '', 
        closestNodePos, 
        draggedNodePos
      );
      
      const connection = {
        source: closestNode.node.id,
        target: node.id,
        sourceHandle,
        targetHandle
      };
      
      if (validateConnection(connection, nodes)) {
        validConnection = connection;
      }
    }
    
    // If we found a valid connection, return it with a unique ID
    if (validConnection) {
      return {
        id: `${validConnection.source}-${validConnection.target}`,
        ...validConnection
      };
    }
    
    return null;
  }, [getInternalNode, store, nodes]);
  
  // Helper functions to determine valid source/target nodes
  function isValidSourceNode(nodeType: string): boolean {
    // Start and Process nodes can be sources
    // MCP nodes can be sources for Process nodes
    return nodeType === 'start' || nodeType === 'process' || nodeType === 'mcp';
  }
  
  function isValidTargetNode(nodeType: string): boolean {
    // Process and Finish nodes can be targets
    // MCP nodes can be targets for Process nodes
    return nodeType === 'process' || nodeType === 'finish' || nodeType === 'mcp';
  }
  
  // Helper functions to determine appropriate handles based on node types and positions
  function getSourceHandle(sourceType: string, targetType: string, sourcePos: any, targetPos: any): string {
    if (sourceType === 'start') {
      return 'start-bottom';
    } else if (sourceType === 'process') {
      if (targetType === 'mcp') {
        // For Process to MCP connections, choose left or right based on relative position
        return sourcePos.x > targetPos.x ? 'process-left-mcp' : 'process-right-mcp';
      } else {
        // For Process to Process/Finish connections, use the bottom handle
        return 'process-bottom';
      }
    } else if (sourceType === 'mcp') {
      // For MCP nodes, choose the handle based on relative position
      const dx = targetPos.x - sourcePos.x;
      const dy = targetPos.y - sourcePos.y;
      
      // Determine which handle to use based on the angle
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      
      if (angle > -45 && angle < 45) {
        return 'mcp-right';
      } else if (angle >= 45 && angle < 135) {
        return 'mcp-bottom';
      } else if (angle >= 135 || angle < -135) {
        return 'mcp-left';
      } else {
        return 'mcp-top';
      }
    }
    
    return ''; // Fallback
  }
  
  function getTargetHandle(targetType: string, sourceType: string, sourcePos: any, targetPos: any): string {
    if (targetType === 'finish') {
      return 'finish-top';
    } else if (targetType === 'process') {
      if (sourceType === 'mcp') {
        // For MCP to Process connections, choose left or right based on relative position
        return targetPos.x > sourcePos.x ? 'process-left-mcp' : 'process-right-mcp';
      } else {
        // For Start/Process to Process connections, use the top handle
        return 'process-top';
      }
    } else if (targetType === 'mcp') {
      // For MCP nodes, choose the handle based on relative position
      const dx = sourcePos.x - targetPos.x;
      const dy = sourcePos.y - targetPos.y;
      
      // Determine which handle to use based on the angle
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      
      if (angle > -45 && angle < 45) {
        return 'mcp-right';
      } else if (angle >= 45 && angle < 135) {
        return 'mcp-bottom';
      } else if (angle >= 135 || angle < -135) {
        return 'mcp-left';
      } else {
        return 'mcp-top';
      }
    }
    
    return ''; // Fallback
  }
  
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
          // Get the source and target nodes
          const sourceNode = nodes.find(n => n.id === closeEdge.source) as FlowNode | undefined;
          const targetNode = nodes.find(n => n.id === closeEdge.target) as FlowNode | undefined;
          
          if (!sourceNode || !targetNode) return nextEdges;
          
          // Determine if this should be an MCP edge
          const isMCPConnection = 
            (sourceNode.type === 'mcp' && targetNode.type === 'process') ||
            (sourceNode.type === 'process' && targetNode.type === 'mcp') ||
            closeEdge.sourceHandle?.includes('mcp') ||
            closeEdge.targetHandle?.includes('mcp');
          
          let tempEdge: Edge;
          
          if (isMCPConnection) {
            tempEdge = {
              ...closeEdge,
              className: 'temp',
              type: 'mcpEdge',
              data: { edgeType: 'mcp' },
              animated: false,
              style: { 
                ...mcpEdgeOptions.style,
                stroke: 'rgba(25, 118, 210, 0.5)', // More transparent version of the MCP edge color
                strokeDasharray: '5,5', // Dotted line
              }
            };
          } else {
            tempEdge = {
              ...closeEdge,
              className: 'temp',
              type: 'custom',
              data: { edgeType: 'standard' },
              animated: false,
              style: { 
                ...defaultEdgeOptions.style,
                stroke: 'rgba(85, 85, 85, 0.5)', // More transparent version of the default edge color
                strokeDasharray: '5,5', // Dotted line
              }
            };
          }
          
          nextEdges.push(tempEdge);
        }
        
        return nextEdges;
      });
    },
    [getClosestEdge, setEdges, nodes]
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
          // Create a permanent edge using the utility function
          const newEdge = createEdgeFromConnection(closeEdge, nodes);
          nextEdges.push(newEdge);
          
          // Notify parent about the new edge
          if (onEdgesChangeCallback) {
            setLastAddedEdge(newEdge);
          }
          
          // Apply a subtle snap-to-connect adjustment if needed
          // Get the nodes involved
          const sourceNode = nodes.find(n => n.id === closeEdge.source);
          const targetNode = nodes.find(n => n.id === closeEdge.target);
          
          if (sourceNode && targetNode) {
            // Determine which node is being dragged
            const draggedNodeId = node.id;
            const otherNodeId = draggedNodeId === sourceNode.id ? targetNode.id : sourceNode.id;
            
            // Get the internal nodes
            const internalDraggedNode = getInternalNode(draggedNodeId);
            const internalOtherNode = getInternalNode(otherNodeId);
            
            if (internalDraggedNode && internalOtherNode && internalDraggedNode.internals && internalOtherNode.internals) {
              // Calculate the snap adjustment based on handle positions and connection type
              const snapAdjustment = calculateSnapAdjustment(
                internalDraggedNode,
                internalOtherNode,
                closeEdge.sourceHandle || '',
                closeEdge.targetHandle || '',
                draggedNodeId === sourceNode.id
              );
              
              // Apply the adjustment if it's significant
              if (Math.abs(snapAdjustment.x) > 1 || Math.abs(snapAdjustment.y) > 1) {
                setNodes((nds: Node[]) => 
                  nds.map((n: Node) => {
                    if (n.id === draggedNodeId) {
                      return {
                        ...n,
                        position: {
                          x: n.position.x + snapAdjustment.x,
                          y: n.position.y + snapAdjustment.y
                        }
                      };
                    }
                    return n;
                  })
                );
              }
            }
          }
        }
        
        return nextEdges;
      });
    },
    [getClosestEdge, setEdges, nodes, onEdgesChangeCallback, setLastAddedEdge, getInternalNode, setNodes]
  );
  
  // Helper function to calculate snap adjustment
  function calculateSnapAdjustment(
    draggedNode: any, 
    otherNode: any, 
    sourceHandle: string, 
    targetHandle: string,
    draggedIsSource: boolean
  ) {
    // Default: no adjustment
    const adjustment = { x: 0, y: 0 };
    
    // Skip adjustment if we don't have position data
    if (!draggedNode.internals?.positionAbsolute || !otherNode.internals?.positionAbsolute) {
      return adjustment;
    }
    
    // Determine if we're connecting top-to-bottom or left-to-right
    if ((sourceHandle.includes('bottom') && targetHandle.includes('top')) || 
        (sourceHandle.includes('top') && targetHandle.includes('bottom'))) {
      // Vertical connection - align horizontally with a subtle adjustment
      adjustment.x = (otherNode.internals.positionAbsolute.x - draggedNode.internals.positionAbsolute.x) * 0.1;
      // Limit the adjustment to prevent large jumps
      adjustment.x = Math.max(Math.min(adjustment.x, 10), -10);
    } else if ((sourceHandle.includes('right') && targetHandle.includes('left')) ||
               (sourceHandle.includes('left') && targetHandle.includes('right'))) {
      // Horizontal connection - align vertically with a subtle adjustment
      adjustment.y = (otherNode.internals.positionAbsolute.y - draggedNode.internals.positionAbsolute.y) * 0.1;
      // Limit the adjustment to prevent large jumps
      adjustment.y = Math.max(Math.min(adjustment.y, 10), -10);
    }
    
    return adjustment;
  }

  return {
    getClosestEdge,
    onNodeDrag,
    onNodeDragStop
  };
}

export default useProximityConnect;
