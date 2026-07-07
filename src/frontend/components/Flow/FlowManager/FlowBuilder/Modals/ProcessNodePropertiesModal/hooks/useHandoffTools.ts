import { useState, useEffect, useMemo } from 'react';
import { FlowNode } from '@/frontend/types/flow/flow';
import { Edge } from '@xyflow/react';
import { createLogger } from '@/utils/logger';
import { buildHandoffToolNameMap } from '@/shared/utils/handoffNaming';
import {
  formatHandoffDescription,
  HandoffNodeSummary,
  HandoffServerSummary,
} from '@/shared/utils/handoffDescription';

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
 * Build a shallow, in-memory summary for the FlowBuilder preview (issue #38,
 * Item A). This runs client-side with only the current flow's nodes, so it
 * cannot resolve a model's display name, a live MCP tool list, or another
 * flow's contents — those are filled in by the runtime synthesizer
 * (buildHandoffDescription) using backend services. The tool NAMES, however,
 * are produced by the same shared helper as the runtime, so the preview and the
 * real handoff tools never disagree on the name (the user-visible fix here).
 */
function buildPreviewSummary(node: FlowNode): HandoffNodeSummary {
  const type = node.type || node.data.type || 'unknown';
  const label = node.data.label || 'Unknown Node';
  const userDescription = node.data.description;
  const properties = (node.data.properties || {}) as Record<string, any>;

  const summary: HandoffNodeSummary = { label, type, userDescription };
  if (userDescription && userDescription.trim()) return summary;

  if (type === 'subflow') {
    // The referenced flow's contents live in another flow not loaded here;
    // the runtime produces the full recursive summary.
    summary.subflowDetailsUnavailable = true;
    return summary;
  }

  if (typeof properties.boundModel === 'string' && properties.boundModel) {
    summary.modelName = properties.boundModel;
  }
  if (typeof properties.promptTemplate === 'string' && properties.promptTemplate.trim()) {
    summary.promptSummary = properties.promptTemplate;
  }
  const mcpNodes = Array.isArray(properties.mcpNodes) ? properties.mcpNodes : [];
  const servers: HandoffServerSummary[] = [];
  const seen = new Set<string>();
  for (const mcpNode of mcpNodes) {
    const boundServer: string | undefined = mcpNode?.properties?.boundServer;
    if (!boundServer || seen.has(boundServer)) continue;
    seen.add(boundServer);
    const enabledTools: string[] = Array.isArray(mcpNode?.properties?.enabledTools)
      ? mcpNode.properties.enabledTools
      : [];
    // Design-time preview: show the tools the node is configured to expose
    // (connection state is only known at run time).
    servers.push({ name: boundServer, connected: true, tools: enabledTools });
  }
  if (servers.length > 0) summary.servers = servers;
  return summary;
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
        // Resolve the target nodes, then name them with the SAME shared helper
        // the runtime uses so the preview matches the real handoff tool names.
        const targetNodes = connectedNodeIds
          .map(id => flowNodes.find(n => n.id === id))
          .filter((n): n is FlowNode => Boolean(n));

        const nameMap = buildHandoffToolNameMap(
          targetNodes.map(n => ({ id: n.id, label: n.data.label, type: n.type || n.data.type })),
        );

        const tools: HandoffTool[] = targetNodes.map(targetNode => ({
          name: nameMap.get(targetNode.id) || `handoff_to_${targetNode.id}`,
          description: formatHandoffDescription(buildPreviewSummary(targetNode)),
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        }));

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

  // Find non-MCP nodes this Process node hands off to: targets of outgoing
  // edges, plus sources of bidirectional edges pointing at this node.
  function findConnectedNonMCPNodes(nodeId: string, allEdges: Edge[]) {
    const targets: string[] = [];
    for (const edge of allEdges) {
      // Some edges might not have edgeType defined at all
      const isMcpEdge = typeof edge.data?.edgeType === 'string' &&
                        edge.data.edgeType.includes('mcp');
      if (isMcpEdge) continue;
      if (edge.source === nodeId) {
        targets.push(edge.target);
      } else if (edge.target === nodeId && (edge.data as { bidirectional?: boolean } | undefined)?.bidirectional) {
        targets.push(edge.source);
      }
    }
    // Unique target node ids (there may be multiple edges between the same nodes)
    return [...new Set(targets)];
  }

  return {
    handoffTools,
    isLoadingHandoffTools
  };
};

export default useHandoffTools;
