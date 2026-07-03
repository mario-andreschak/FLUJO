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

  // Generate handoff tools based on connected nodes. When the node has no
  // outgoing connections yet (a normal state while building a flow), the
  // list is simply empty — the tab renders its empty state.
  useEffect(() => {
    if (open && node) {
      setIsLoadingHandoffTools(true);

      try {
        const tools: HandoffTool[] = [];

        connectedNodeIds.forEach(targetNodeId => {
          const targetNode = flowNodes.find(n => n.id === targetNodeId);

          if (!targetNode) {
            log.warn(`Target node not found for ID ${targetNodeId}`);
            return;
          }

          const targetNodeLabel = targetNode.data.label || 'Unknown Node';
          const targetNodeType = targetNode.type || 'unknown';

          tools.push({
            name: `handoff_to_${targetNodeId}`,
            description: `Hand off execution to ${targetNodeLabel} (${targetNodeType})`,
            inputSchema: {
              type: "object",
              properties: {}, // No parameters needed anymore
              required: []
            }
          });
        });

        setHandoffTools(tools);
        log.debug('Generated handoff tools', { toolsCount: tools.length });
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

  // Find non-MCP nodes this Process node hands off to (outgoing edges only)
  function findConnectedNonMCPNodes(nodeId: string, allEdges: Edge[]) {
    const outgoingEdges = allEdges.filter(edge => {
      const isOutgoing = edge.source === nodeId;
      // Some edges might not have edgeType defined at all
      const isMcpEdge = typeof edge.data?.edgeType === 'string' &&
                        edge.data.edgeType.includes('mcp');
      return isOutgoing && !isMcpEdge;
    });

    // Unique target node ids (there may be multiple edges between the same nodes)
    return [...new Set(outgoingEdges.map(edge => edge.target))];
  }

  return {
    handoffTools,
    isLoadingHandoffTools
  };
};

export default useHandoffTools;
