import type { Edge } from '@xyflow/react';
import type { Flow, FlowNode } from '@/shared/types/flow';

export interface GuidedSubagentLink {
  processNodeId: string;
  subflowNodeId: string;
}

/**
 * Guided mode represents a callable helper agent as the runtime's established
 * Process <-> Subflow shape. The reverse edge returns the condensed child
 * result to the calling Process instead of inserting the child into the main
 * linear sequence.
 */
export function getGuidedSubagentLinks(nodes: FlowNode[], edges: Edge[]): GuidedSubagentLink[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const links: GuidedSubagentLink[] = [];

  for (const edge of edges) {
    if ((edge.data as { bidirectional?: boolean } | undefined)?.bidirectional !== true) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;

    if (source.data.type === 'process' && target.data.type === 'subflow') {
      links.push({ processNodeId: source.id, subflowNodeId: target.id });
    } else if (source.data.type === 'subflow' && target.data.type === 'process') {
      links.push({ processNodeId: target.id, subflowNodeId: source.id });
    }
  }

  return links;
}

export function isCanonicalGuidedSubagent(node: FlowNode): boolean {
  const properties = node.data.properties ?? {};
  return node.data.type === 'subflow'
    && properties.inputMode === 'isolated'
    && properties.outputMode === 'final-only';
}

/** Apply the execution contract used by the Guided "Talks to other Agents" picker. */
export function configureGuidedSubagentNode(node: FlowNode, agent: Pick<Flow, 'id' | 'name' | 'description'>): FlowNode {
  return {
    ...node,
    type: 'subflow',
    data: {
      ...node.data,
      type: 'subflow',
      label: agent.name,
      ...(agent.description ? { description: agent.description } : {}),
      properties: {
        ...(node.data.properties ?? {}),
        subflowId: agent.id,
        inputMode: 'isolated',
        outputMode: 'final-only',
      },
    },
  };
}

/** Mark the Process -> Subflow control edge as a returning subagent call. */
export function configureGuidedSubagentEdge(edge: Edge): Edge {
  return {
    ...edge,
    data: {
      ...(edge.data ?? {}),
      edgeType: 'standard',
      bidirectional: true,
    },
  };
}
