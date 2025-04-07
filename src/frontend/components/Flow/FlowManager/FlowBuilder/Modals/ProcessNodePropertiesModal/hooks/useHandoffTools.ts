import { useState, useEffect, useMemo } from 'react';
import { FlowNode } from '@/frontend/types/flow/flow';
import { Edge } from '@xyflow/react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/flow/FlowBuilder/Modals/ProcessNodePropertiesModal/hooks/useHandoffTools');

// Define the structure for handoff tools
export interface HandoffTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

/**
 * Custom hook for managing handoff tools in the Process Node Properties Modal
 * 
 * This hook extracts handoff tools based on the node's successors
 */
const useHandoffTools = (
  open: boolean, 
  node: FlowNode | null, 
  flowEdges: Edge[], 
  flowNodes: FlowNode[]
) => {
  const [handoffTools, setHandoffTools] = useState<HandoffTool[]>([]);
  const [isLoadingHandoffTools, setIsLoadingHandoffTools] = useState<boolean>(false);

  // Find connected non-MCP nodes (potential handoff targets)
  const connectedNodeIds = useMemo(() => {
    if (!node) return [];
    
    // Log the current node and all edges for debugging
    log.debug('Finding connected nodes for', { 
      nodeId: node.id, 
      nodeType: node.type,
      nodeLabel: node.data?.label,
      edgesCount: flowEdges.length
    });
    
    // Log all edges for debugging
    flowEdges.forEach(edge => {
      log.debug('Edge:', { 
        id: edge.id, 
        source: edge.source, 
        target: edge.target, 
        type: edge.type,
        edgeType: edge.data?.edgeType
      });
    });
    
    return findConnectedNonMCPNodes(node.id, flowEdges);
  }, [node, flowEdges]);

  // Generate handoff tools based on connected nodes
  useEffect(() => {
    if (open && node) {
      setIsLoadingHandoffTools(true);
      
      // Log the connected node IDs
      log.debug('Connected node IDs:', { connectedNodeIds });
      
      try {
        const tools: HandoffTool[] = [];
        
        // Log all flow nodes for debugging
        log.debug('All flow nodes:', { 
          count: flowNodes.length,
          nodes: flowNodes.map(n => ({ 
            id: n.id, 
            type: n.type, 
            label: n.data?.label 
          }))
        });
        
        // Create a handoff tool for each connected node
        if (connectedNodeIds.length > 0) {
          connectedNodeIds.forEach(targetNodeId => {
            const targetNode = flowNodes.find(n => n.id === targetNodeId);
            
            if (!targetNode) {
              log.warn(`Target node not found for ID ${targetNodeId}`);
              return;
            }
            
            const targetNodeLabel = targetNode.data.label || 'Unknown Node';
            const targetNodeType = targetNode.type || 'unknown';
            
            // Create a handoff tool for this node
            const handoffTool: HandoffTool = {
              name: `handoff_to_${targetNodeId}`,
              description: `Hand off execution to ${targetNodeLabel} (${targetNodeType})`,
              inputSchema: {
                type: "object",
                properties: {}, // No parameters needed anymore
                required: []
              }
            };
            
            tools.push(handoffTool);
            
            log.debug(`Created handoff tool for node ${targetNodeId}`, {
              toolName: handoffTool.name,
              targetNodeLabel
            });
          });
        } else {
          // If no connected nodes were found, create a debug message
          log.warn('No connected nodes found for handoff tools', {
            nodeId: node.id,
            nodeType: node.type,
            nodeLabel: node.data?.label
          });
          
          // For debugging: Create a dummy handoff tool to show in the UI
          // This helps verify that the component is working correctly
          const dummyTool: HandoffTool = {
            name: "debug_no_connected_nodes",
            description: "No connected nodes found for handoff. This is a debug tool.",
            inputSchema: {
              type: "object",
              properties: {
                debug: {
                  type: "boolean",
                  description: "This is a debug tool"
                }
              },
              required: ["debug"]
            }
          };
          
          tools.push(dummyTool);
        }
        
        // Removed the generic handoff tool creation block
        
        setHandoffTools(tools);
        log.info('Generated handoff tools', {
          toolsCount: tools.length
        });
      } catch (error) {
        log.error('Error generating handoff tools', error);
        setHandoffTools([]);
      } finally {
        setIsLoadingHandoffTools(false);
      }
    } else {
      setHandoffTools([]);
    }
  }, [open, node, connectedNodeIds, flowEdges, flowNodes]);

  // Find non-MCP nodes connected to this Process node
  function findConnectedNonMCPNodes(nodeId: string, allEdges: Edge[]) {
    // Log the node ID we're finding connections for
    log.debug(`Finding connected nodes for ${nodeId}`);
    
    // First, log all edges for debugging
    log.debug('All edges:', { 
      count: allEdges.length,
      edges: allEdges.map(e => ({ 
        id: e.id, 
        source: e.source, 
        target: e.target, 
        type: e.type, 
        edgeType: e.data?.edgeType 
      }))
    });
    
    // Get all outgoing edges from this node that are not MCP edges
    const outgoingEdges = allEdges.filter(edge => {
      // Check if this is an outgoing edge from the current node
      const isOutgoing = edge.source === nodeId;
      
      // Check if this is an MCP edge - be more lenient in what we consider "not an MCP edge"
      // Some edges might not have edgeType defined at all
      const isMcpEdge = typeof edge.data?.edgeType === 'string' && 
                        (edge.data.edgeType.includes('mcp') || 
                         edge.data.edgeType.includes('mcpEdge'));
      
      // Log each edge for debugging
      log.debug(`Edge ${edge.id}: source=${edge.source}, target=${edge.target}, type=${edge.type}, edgeType=${edge.data?.edgeType}`, {
        isOutgoing,
        isMcpEdge,
        isIncluded: isOutgoing && !isMcpEdge
      });
      
      // Only include edges where this node is the source (outgoing edges)
      // and the edge is not an MCP edge
      return isOutgoing && !isMcpEdge;
    });
    
    // Log the outgoing edges
    log.debug('Outgoing non-MCP edges:', { 
      count: outgoingEdges.length,
      edges: outgoingEdges.map(e => ({ id: e.id, target: e.target }))
    });
    
    // Get the target node IDs
    const targetNodeIds = outgoingEdges
      .map(edge => edge.target)
      // Ensure uniqueness in case of multiple edges between the same nodes
      .filter((value, index, self) => self.indexOf(value) === index);
    
    // Log the target node IDs
    log.debug('Target node IDs:', { targetNodeIds });
    
    return targetNodeIds;
  }

  return {
    handoffTools,
    isLoadingHandoffTools
  };
};

export default useHandoffTools;
