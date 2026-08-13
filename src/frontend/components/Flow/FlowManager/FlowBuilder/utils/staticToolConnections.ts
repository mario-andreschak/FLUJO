import type { Edge } from '@xyflow/react';
import type { FlowNode } from '@/frontend/types/flow/flow';
import { createEdgeFromConnection } from '../Canvas/utils/edgeUtils';

export interface StaticRealToolEntry {
  kind: 'toolCall';
  executionMode?: 'mock' | 'real';
  serverName?: string;
  toolName: string;
}

interface ReconcileStaticToolConnectionsInput {
  staticNodeId: string;
  entries: Array<Record<string, unknown>>;
  nodes: FlowNode[];
  edges: Edge[];
  createMcpNode: (serverName: string, position: { x: number; y: number }) => FlowNode;
}

/**
 * Reconcile the graph attachments implied by a Static node's real tool calls.
 * One server produces one MCP node/edge; repeated calls merge their tool names.
 * Existing enabled tools are retained so a shared or manually refined MCP node
 * never loses capabilities as a side effect of editing conversation replay.
 */
export function reconcileStaticToolConnections({
  staticNodeId,
  entries,
  nodes,
  edges,
  createMcpNode,
}: ReconcileStaticToolConnectionsInput): { nodes: FlowNode[]; edges: Edge[] } {
  const staticNode = nodes.find((node) => node.id === staticNodeId && node.data.type === 'static');
  if (!staticNode) return { nodes, edges };

  const required = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (raw?.kind !== 'toolCall' || raw.executionMode !== 'real') continue;
    const serverName = typeof raw.serverName === 'string' ? raw.serverName.trim() : '';
    const toolName = typeof raw.toolName === 'string' ? raw.toolName.trim() : '';
    if (!serverName || !toolName) continue;
    const tools = required.get(serverName) ?? new Set<string>();
    tools.add(toolName);
    required.set(serverName, tools);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const attached = edges.flatMap((edge) => {
    if (edge.data?.edgeType !== 'mcp') return [];
    const otherId = edge.source === staticNodeId
      ? edge.target
      : edge.target === staticNodeId
        ? edge.source
        : null;
    if (!otherId) return [];
    const mcpNode = nodeById.get(otherId);
    if (mcpNode?.data.type !== 'mcp') return [];
    const serverName = typeof mcpNode.data.properties?.boundServer === 'string'
      ? mcpNode.data.properties.boundServer
      : '';
    return [{ edge, mcpNode, serverName }];
  });

  const keptByServer = new Map<string, FlowNode>();
  const removedEdgeIds = new Set<string>();
  for (const connection of attached) {
    if (!required.has(connection.serverName) || keptByServer.has(connection.serverName)) {
      removedEdgeIds.add(connection.edge.id);
      continue;
    }
    keptByServer.set(connection.serverName, connection.mcpNode);
  }

  let nextEdges = edges.filter((edge) => !removedEdgeIds.has(edge.id));
  let nextNodes = nodes.map((node) => {
    if (node.data.type !== 'mcp') return node;
    const serverName = typeof node.data.properties?.boundServer === 'string'
      ? node.data.properties.boundServer
      : '';
    if (keptByServer.get(serverName)?.id !== node.id) return node;
    const enabled = new Set<string>(Array.isArray(node.data.properties?.enabledTools)
      ? node.data.properties.enabledTools
      : []);
    required.get(serverName)?.forEach((toolName) => enabled.add(toolName));
    return {
      ...node,
      data: {
        ...node.data,
        properties: { ...node.data.properties, enabledTools: [...enabled] },
      },
    };
  });

  const orphanCandidates = new Set(attached
    .filter((connection) => removedEdgeIds.has(connection.edge.id))
    .map((connection) => connection.mcpNode.id));
  nextNodes = nextNodes.filter((node) => (
    !orphanCandidates.has(node.id)
    || nextEdges.some((edge) => edge.source === node.id || edge.target === node.id)
  ));

  let serverIndex = 0;
  for (const [serverName, toolNames] of required) {
    if (keptByServer.has(serverName)) {
      serverIndex += 1;
      continue;
    }
    const mcpNode = createMcpNode(serverName, {
      x: staticNode.position.x + 350,
      y: staticNode.position.y + serverIndex * 120,
    });
    mcpNode.data.label = serverName;
    mcpNode.data.properties = {
      ...(mcpNode.data.properties ?? {}),
      boundServer: serverName,
      enabledTools: [...toolNames],
    };
    const edge = createEdgeFromConnection({
      source: staticNodeId,
      sourceHandle: 'static-right-mcp',
      target: mcpNode.id,
      targetHandle: 'mcp-left',
    }, [...nextNodes, mcpNode]);
    nextNodes = [...nextNodes, mcpNode];
    nextEdges = [...nextEdges, edge];
    serverIndex += 1;
  }

  return { nodes: nextNodes, edges: nextEdges };
}
