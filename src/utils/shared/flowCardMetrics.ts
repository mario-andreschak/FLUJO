import type { Edge } from '@xyflow/react';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { isAttachmentEdge } from '@/utils/shared/connectionRules';

/** The graph-aware counts surfaced on a Flow card. */
export interface FlowCardMetrics {
  stepCount: number;
  subagentCount: number;
  signalCount: number;
}

function nodeType(node: FlowNode | undefined): string {
  return String(node?.data?.type ?? node?.type ?? '');
}

function isBidirectional(edge: Edge): boolean {
  return (edge.data as { bidirectional?: boolean } | undefined)?.bidirectional === true;
}

/**
 * Classify the nodes a person sees as executable work on the Flow card.
 *
 * Process nodes are always steps. Attachment and routing nodes are not. A
 * subflow is a sequential step only in the A -> subflow -> B shape (A and B
 * must differ); a call-and-return subflow connected bidirectionally to a
 * Process, or a leaf subflow with one incoming edge, is a sub-agent instead.
 */
export function getFlowCardMetrics(flow: Pick<Flow, 'nodes' | 'edges'>): FlowCardMetrics {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow.edges) ? flow.edges : [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const controlEdges = edges.filter((edge) => !isAttachmentEdge(edge));

  let stepCount = 0;
  let subagentCount = 0;
  let signalCount = 0;

  for (const node of nodes) {
    const type = nodeType(node);

    if (type === 'process') {
      stepCount += 1;
      continue;
    }

    if (type === 'signal') {
      const topic = node.data?.properties?.topic;
      if (typeof topic === 'string' && topic.trim()) signalCount += 1;
      continue;
    }

    if (type !== 'subflow') continue;

    const connectedEdges = controlEdges.filter(
      (edge) => edge.source === node.id || edge.target === node.id,
    );
    const hasBidirectionalProcess = connectedEdges.some((edge) => {
      if (!isBidirectional(edge)) return false;
      const otherId = edge.source === node.id ? edge.target : edge.source;
      return nodeType(nodesById.get(otherId)) === 'process';
    });

    const incoming = connectedEdges.filter(
      (edge) => !isBidirectional(edge) && edge.target === node.id,
    );
    const outgoing = connectedEdges.filter(
      (edge) => !isBidirectional(edge) && edge.source === node.id,
    );
    const isSequentialStep = incoming.some((inEdge) =>
      outgoing.some((outEdge) => inEdge.source !== outEdge.target),
    );

    if (hasBidirectionalProcess || (incoming.length === 1 && outgoing.length === 0)) {
      subagentCount += 1;
    } else if (isSequentialStep) {
      stepCount += 1;
    }
  }

  return { stepCount, subagentCount, signalCount };
}
