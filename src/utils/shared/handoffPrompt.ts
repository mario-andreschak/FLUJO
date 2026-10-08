import type { Edge } from '@xyflow/react';
import type { FlowNode } from '@/shared/types/flow';
import type { EdgeCondition } from './edgeConditions';
import { buildHandoffToolNameMap } from '@/shared/utils/handoffNaming';
import { encodeBindingPill, findBindings } from './mcpBinding';

export interface PromptHandoff {
  targetId: string;
  toolName: string;
  targetLabel: string;
  targetType: string;
  edgeCondition?: EdgeCondition;
}

interface HandoffGraph {
  nodes: FlowNode[];
  edges: Edge[];
}

interface ReconcileHandoffPromptInput {
  prompt: string;
  nodeId: string;
  previous: HandoffGraph;
  next: HandoffGraph;
}

const HANDOFF_SECTION = /(?:\r?\n){2,}(?:#{1,6}\s*)?handoff conditions\s*:/i;

function isAttachmentEdge(edge: Edge): boolean {
  const edgeType = (edge.data as { edgeType?: string } | undefined)?.edgeType;
  return edge.type === 'mcpEdge'
    || edgeType === 'mcp'
    || edgeType === 'resource'
    || !!edgeType?.includes('mcp');
}

/** Return every handoff tool exposed by a Process node, in runtime edge order. */
export function promptHandoffsForNode(graph: HandoffGraph, nodeId: string): PromptHandoff[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const targets: Array<{ id: string; edgeCondition?: EdgeCondition }> = [];
  const seen = new Set<string>();

  for (const edge of graph.edges) {
    if (isAttachmentEdge(edge)) continue;
    const data = edge.data as {
      bidirectional?: boolean;
      condition?: EdgeCondition;
    } | undefined;
    let targetId: string | undefined;
    let edgeCondition: EdgeCondition | undefined;
    if (edge.source === nodeId) {
      targetId = edge.target;
      edgeCondition = data?.condition;
    } else if (edge.target === nodeId && data?.bidirectional === true) {
      targetId = edge.source;
    }
    if (!targetId || seen.has(targetId) || !nodesById.has(targetId)) continue;
    seen.add(targetId);
    targets.push({ id: targetId, edgeCondition });
  }

  const nameMap = buildHandoffToolNameMap(targets.map(({ id }) => {
    const target = nodesById.get(id)!;
    return { id, label: target.data.label, type: target.type || target.data.type };
  }));

  return targets.map(({ id, edgeCondition }) => {
    const target = nodesById.get(id)!;
    return {
      targetId: id,
      toolName: nameMap.get(id) || `handoff_to_${id}`,
      targetLabel: target.data.label || target.data.type || 'next step',
      targetType: target.data.type || target.type || 'node',
      ...(edgeCondition ? { edgeCondition } : {}),
    };
  });
}

export function fallbackPromptHandoffCondition(handoff: PromptHandoff): string {
  const condition = handoff.edgeCondition;
  if (!condition || condition.kind === 'always') {
    return handoff.targetType === 'finish'
      ? 'When this step is complete'
      : `When the workflow should continue to ${handoff.targetLabel}`;
  }
  const value = typeof condition.value === 'string' ? condition.value : '';
  const target = condition.target === 'last-message' ? 'latest message' : 'result';
  if (condition.kind === 'contains') {
    return condition.negate
      ? `If the ${target} does not contain "${value}"`
      : `If the ${target} contains "${value}"`;
  }
  if (condition.kind === 'equals') {
    return condition.negate
      ? `If the ${target} does not equal "${value}"`
      : `If the ${target} equals "${value}"`;
  }
  return condition.negate
    ? `If the ${target} does not match /${value}/`
    : `If the ${target} matches /${value}/`;
}

function splitHandoffSection(prompt: string): { base: string; section: string; found: boolean } {
  const match = HANDOFF_SECTION.exec(prompt);
  if (!match) return { base: prompt.trim(), section: '', found: false };
  return {
    base: prompt.slice(0, match.index).trim(),
    section: prompt.slice(match.index + match[0].length).trim(),
    found: true,
  };
}

function conditionsByTarget(section: string, previous: PromptHandoff[]): Map<string, string> {
  const targetByTool = new Map(previous.map((handoff) => [handoff.toolName, handoff.targetId]));
  const result = new Map<string, string>();
  for (const line of section.split(/\r?\n/)) {
    const binding = findBindings(line).find((candidate) =>
      candidate.kind === 'tool' && candidate.server === 'handoff'
    );
    if (!binding) continue;
    const targetId = targetByTool.get(binding.name);
    if (!targetId) continue;
    const prefix = line.slice(0, binding.index);
    const match = /^\s*-\s*(.*?),\s*hand off to\s*$/i.exec(prefix);
    if (match?.[1]?.trim()) result.set(targetId, match[1].trim());
  }
  return result;
}

function rewriteHandoffBindings(text: string, renameMap: Map<string, string>): string {
  const bindings = findBindings(text)
    .filter((binding) => binding.kind === 'tool' && binding.server === 'handoff')
    .sort((a, b) => b.index - a.index);
  let result = text;
  for (const binding of bindings) {
    const replacement = renameMap.get(binding.name);
    if (!replacement || replacement === binding.name) continue;
    result = `${result.slice(0, binding.index)}${encodeBindingPill('tool', 'handoff', replacement)}${result.slice(binding.index + binding.fullMatch.length)}`;
  }
  return result;
}

/**
 * Keep the generated handoff section synchronized after a Guided topology edit.
 * Existing conditions for unchanged targets survive; a one-for-one successor
 * replacement (the Guided next-step insertion) also carries its condition over.
 */
export function reconcileHandoffPromptForTopologyChange(
  input: ReconcileHandoffPromptInput,
): string {
  const previous = promptHandoffsForNode(input.previous, input.nodeId);
  const next = promptHandoffsForNode(input.next, input.nodeId);
  const split = splitHandoffSection(input.prompt);
  const preservedConditions = conditionsByTarget(split.section, previous);
  const previousById = new Map(previous.map((handoff) => [handoff.targetId, handoff]));
  const nextById = new Map(next.map((handoff) => [handoff.targetId, handoff]));
  const removed = previous.filter((handoff) => !nextById.has(handoff.targetId));
  const added = next.filter((handoff) => !previousById.has(handoff.targetId));
  const replacementTarget = removed.length === 1 && added.length === 1
    ? new Map([[added[0].targetId, removed[0].targetId]])
    : new Map<string, string>();

  const renameMap = new Map<string, string>();
  for (const handoff of next) {
    const old = previousById.get(handoff.targetId);
    if (old) renameMap.set(old.toolName, handoff.toolName);
  }
  if (removed.length === 1 && added.length === 1) {
    renameMap.set(removed[0].toolName, added[0].toolName);
  }
  const base = rewriteHandoffBindings(split.base, renameMap).trim();
  if (next.length === 0) return base;

  const referencedInBase = new Set(
    findBindings(base)
      .filter((binding) => binding.kind === 'tool' && binding.server === 'handoff')
      .map((binding) => binding.name),
  );
  const lines = next
    .filter((handoff) => split.found || !referencedInBase.has(handoff.toolName))
    .map((handoff) => {
      const previousTargetId = replacementTarget.get(handoff.targetId);
      const condition = preservedConditions.get(handoff.targetId)
        ?? (previousTargetId ? preservedConditions.get(previousTargetId) : undefined)
        ?? fallbackPromptHandoffCondition(handoff);
      return `- ${condition}, hand off to ${encodeBindingPill('tool', 'handoff', handoff.toolName)}.`;
    });
  if (lines.length === 0) return base;
  return `${base}${base ? '\n\n' : ''}Handoff conditions:\n${lines.join('\n')}`;
}
