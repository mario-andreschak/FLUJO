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
    
    return findConnectedNonMCPNodes(node.id, flowEdges);
  }, [node, flowEdges]);

  // Generate handoff tools based on connected nodes
  useEffect(() => {
    if (open && node && connectedNodeIds.length > 0) {
      setIsLoadingHandoffTools(true);
      
      try {
        const tools: HandoffTool[] = [];
        
        // Create a handoff tool for each connected node
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
              properties: {
                confirm: {
                  type: "boolean",
                  description: "Set to true to confirm handoff"
                }
              },
              required: ["confirm"]
            }
          };
          
          tools.push(handoffTool);
          
          log.debug(`Created handoff tool for node ${targetNodeId}`, {
            toolName: handoffTool.name,
            targetNodeLabel
          });
        });
        
        // Add a generic handoff tool if there are multiple connected nodes
        if (connectedNodeIds.length > 1) {
          // Get all edges from this node to other nodes
          const outgoingEdges = flowEdges.filter(edge => 
            edge.source === node.id && 
            !(typeof edge.data?.edgeType === 'string' && edge.data.edgeType.includes('mcp'))
          );
          
          const edgeIds = outgoingEdges.map(edge => edge.id);
          
          const genericHandoffTool: HandoffTool = {
            name: "handoff",
            description: "Hand off execution to another node in the flow",
            inputSchema: {
              type: "object",
              properties: {
                edgeId: {
                  type: "string",
                  description: "ID of the edge to follow",
                  enum: edgeIds
                }
              },
              required: ["edgeId"]
            }
          };
          
          tools.push(genericHandoffTool);
          
          log.debug('Created generic handoff tool', {
            availableEdges: edgeIds
          });
        }
        
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
    return allEdges
      .filter(edge =>
        // Only include edges where this node is the source (outgoing edges)
        // and the edge is not an MCP edge
        edge.source === nodeId && 
        (!edge.data?.edgeType || !(typeof edge.data.edgeType === 'string' && edge.data.edgeType.includes('mcp')))
      )
      .map(edge => edge.target)
      // Ensure uniqueness in case of multiple edges between the same nodes
      .filter((value, index, self) => self.indexOf(value) === index);
  }

  return {
    handoffTools,
    isLoadingHandoffTools
  };
};

export default useHandoffTools;
