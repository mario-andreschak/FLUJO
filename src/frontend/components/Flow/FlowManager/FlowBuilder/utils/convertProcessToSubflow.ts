import { v4 as uuidv4 } from 'uuid';
import type { Edge } from '@xyflow/react';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { isAttachmentEdge } from '@/utils/shared/connectionRules';
import type { TranslationValues, Translator } from '@/frontend/i18n/core';
import type { PluralTranslationKey, TranslationKey } from '@/frontend/i18n/messages';

export interface ProcessToSubflowError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ConversionBoundary {
  edgeId: string;
  insideNodeId: string;
  outsideNodeId: string;
  outsideLabel: string;
}

export interface ProcessToSubflowPreview {
  includedNodes: Array<{ id: string; label: string; type: string }>;
  attachmentCount: number;
  signalCount: number;
  internalEdgeCount: number;
  inputCount: number;
  outputCount: number;
  excludedBoundaryNodes: Array<{ id: string; label: string; type: string }>;
  rewires: string[];
  warnings: string[];
}

export interface ProcessToSubflowDraft {
  valid: boolean;
  errors: ProcessToSubflowError[];
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  boundaryInputs: ConversionBoundary[];
  boundaryOutputs: ConversionBoundary[];
  childFlow?: Flow;
  parentFlow?: Flow;
  preview: ProcessToSubflowPreview;
}

export interface BuildProcessToSubflowDraftOptions {
  parentFlow: Flow;
  processNodeId: string;
  subflowName: string;
  existingFlowNames?: string[];
  /** Test seam that also keeps the graph rewrite deterministic for callers that need it. */
  createId?: () => string;
  t?: Translator;
  tp?: (key: PluralTranslationKey, count: number, values?: TranslationValues) => string;
}

const translateOr = (
  t: Translator | undefined,
  key: TranslationKey,
  fallback: string,
  values?: TranslationValues,
) => t ? t(key, values) : fallback;

const pluralOr = (
  tp: BuildProcessToSubflowDraftOptions['tp'],
  key: PluralTranslationKey,
  count: number,
  fallback: string,
) => tp ? tp(key, count) : fallback;

type LogicalBoundary = ConversionBoundary & { edge: Edge };

const edgeData = (edge: Edge) => edge.data as { edgeType?: string; bidirectional?: boolean } | undefined;
const isBidirectional = (edge: Edge) => edgeData(edge)?.bidirectional === true;
const isControlEdge = (edge: Edge) => !isAttachmentEdge(edge as { data?: { edgeType?: unknown } | null });
const nodeType = (node: FlowNode | undefined) => String(node?.type ?? node?.data?.type ?? '');
const nodeLabel = (node: FlowNode | undefined) => String(node?.data?.label ?? node?.id ?? 'Unknown node');

function makeControlEdge(
  id: string,
  source: string,
  target: string,
  sourceHandle: string,
  targetHandle: string,
  template?: Edge,
): Edge {
  if (template) {
    return {
      ...template,
      id,
      source,
      target,
      sourceHandle,
      targetHandle,
      data: { ...(template.data ?? {}), edgeType: 'standard', bidirectional: false },
      markerStart: undefined,
    };
  }
  return {
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    type: 'custom',
    animated: true,
    data: { edgeType: 'standard' },
  };
}

/**
 * Build a non-mutating Process -> Subflow conversion draft.
 *
 * Output policy: the parent Subflow runtime supports one control exit, so zero
 * or one distinct boundary output is accepted. Multiple exits and
 * bidirectional boundary crossings are rejected instead of silently changing
 * routing semantics. Parallel branches with no parent successor are joined at
 * the child Finish node and remain valid.
 */
export function buildProcessToSubflowDraft({
  parentFlow,
  processNodeId,
  subflowName,
  existingFlowNames = [],
  createId = uuidv4,
  t,
  tp,
}: BuildProcessToSubflowDraftOptions): ProcessToSubflowDraft {
  const errors: ProcessToSubflowError[] = [];
  const warnings: string[] = [];
  const nodes = parentFlow.nodes ?? [];
  const edges = parentFlow.edges ?? [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const target = byId.get(processNodeId);
  const trimmedName = subflowName.trim();

  if (!target || nodeType(target) !== 'process') {
    errors.push({
      code: 'target-not-process',
      message: translateOr(t, 'flows.convert.error.target', 'The selected node no longer exists or is not a Process node.'),
      nodeId: processNodeId,
    });
  }
  if (!trimmedName) {
    errors.push({ code: 'name-required', message: translateOr(t, 'flows.convert.error.nameRequired', 'Enter a name for the new subflow.') });
  } else if (!/^[\w-]+$/.test(trimmedName)) {
    errors.push({
      code: 'invalid-name',
      message: translateOr(t, 'flows.convert.error.invalidName', 'The subflow name may contain only letters, numbers, underscores, and dashes.'),
    });
  } else if (existingFlowNames.some(name => name.toLowerCase() === trimmedName.toLowerCase())) {
    errors.push({
      code: 'duplicate-name',
      message: translateOr(t, 'flows.convert.error.duplicateName', `A flow named "${trimmedName}" already exists.`, { name: trimmedName }),
    });
  }

  const selected = new Set<string>();
  if (target) selected.add(target.id);

  // Signals are inline control nodes. Follow only logical outgoing control
  // transitions and stop before every Process/Subflow (or other execution)
  // successor. Attachment edges never participate in this traversal.
  const queue = target ? [target.id] : [];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const edge of edges) {
      if (!isControlEdge(edge)) continue;
      const nextIds: string[] = [];
      if (edge.source === currentId) nextIds.push(edge.target);
      if (isBidirectional(edge) && edge.target === currentId) nextIds.push(edge.source);
      for (const nextId of nextIds) {
        if (selected.has(nextId)) continue;
        const next = byId.get(nextId);
        if (!next) {
          errors.push({
            code: 'missing-edge-node',
            message: translateOr(t, 'flows.convert.error.missingEdgeNode', `Edge "${edge.id}" points to a missing node. Repair the flow before converting.`, { edge: edge.id }),
            edgeId: edge.id,
          });
          continue;
        }
        const type = nodeType(next);
        if (type === 'signal') {
          selected.add(nextId);
          queue.push(nextId);
        } else if (type === 'mcp' || type === 'resource') {
          errors.push({
            code: 'attachment-on-control-edge',
            message: translateOr(t, 'flows.convert.error.attachmentControl', `${nodeLabel(next)} is connected as control flow. Reconnect it with its ${type.toUpperCase()} attachment handles before converting.`, { node: nodeLabel(next), type: type.toUpperCase() }),
            nodeId: nextId,
            edgeId: edge.id,
          });
        }
        // Process, Subflow, Finish, Start, and Trigger nodes are parent boundaries.
      }
    }
  }

  // Pull MCP/Resource attachments into the selected region. Iterate because a
  // resource may be reached through either orientation of its directional edge.
  let addedAttachment = true;
  while (addedAttachment) {
    addedAttachment = false;
    for (const edge of edges) {
      if (!isAttachmentEdge(edge as { data?: { edgeType?: unknown } | null })) continue;
      const sourceSelected = selected.has(edge.source);
      const targetSelected = selected.has(edge.target);
      if (sourceSelected === targetSelected) continue;
      const otherId = sourceSelected ? edge.target : edge.source;
      const other = byId.get(otherId);
      const type = nodeType(other);
      if (type === 'mcp' || type === 'resource') {
        selected.add(otherId);
        addedAttachment = true;
      } else {
        errors.push({
          code: 'unsupported-attachment',
          message: translateOr(t, 'flows.convert.error.unsupportedAttachment', `Attachment edge "${edge.id}" does not connect to an MCP or Resource node.`, { edge: edge.id }),
          edgeId: edge.id,
          nodeId: otherId,
        });
      }
    }
  }

  const internalEdges = edges.filter(edge => selected.has(edge.source) && selected.has(edge.target));
  const boundaryInputs: LogicalBoundary[] = [];
  const boundaryOutputs: LogicalBoundary[] = [];
  const boundaryNodeIds = new Set<string>();

  for (const edge of edges) {
    const sourceSelected = selected.has(edge.source);
    const targetSelected = selected.has(edge.target);
    if (sourceSelected === targetSelected) continue;

    if (isAttachmentEdge(edge as { data?: { edgeType?: unknown } | null })) {
      errors.push({
        code: 'shared-attachment',
        message: translateOr(t, 'flows.convert.error.sharedAttachment', `Attachment "${edge.id}" is also used outside the converted region. Duplicate or disconnect that attachment first.`, { edge: edge.id }),
        edgeId: edge.id,
      });
      continue;
    }

    const insideNodeId = sourceSelected ? edge.source : edge.target;
    const outsideNodeId = sourceSelected ? edge.target : edge.source;
    const boundary: LogicalBoundary = {
      edge,
      edgeId: edge.id,
      insideNodeId,
      outsideNodeId,
      outsideLabel: nodeLabel(byId.get(outsideNodeId)),
    };
    boundaryNodeIds.add(outsideNodeId);
    if (sourceSelected) boundaryOutputs.push(boundary);
    else boundaryInputs.push(boundary);

    if (isBidirectional(edge)) {
      // One physical bidirectional crossing is both an input and an output. It
      // cannot be represented by the Subflow's separate top/bottom handles
      // without changing the edge semantics, so reject it explicitly.
      (sourceSelected ? boundaryInputs : boundaryOutputs).push(boundary);
      errors.push({
        code: 'bidirectional-boundary',
        message: translateOr(t, 'flows.convert.error.bidirectional', `Boundary edge "${edge.id}" is bidirectional. Make it one-way before converting; internal bidirectional edges are preserved.`, { edge: edge.id }),
        edgeId: edge.id,
      });
    }
  }

  const uniqueOutputs = [...new Map(boundaryOutputs.map(boundary => [boundary.edgeId, boundary])).values()];
  if (uniqueOutputs.length > 1) {
    errors.push({
      code: 'multiple-outputs',
      message: pluralOr(tp, 'flows.convert.error.outputs', uniqueOutputs.length, `This region has ${uniqueOutputs.length} distinct parent exits. A Subflow supports one outgoing control path; join the branches before converting.`),
    });
  }

  const selectedNodes = nodes.filter(node => selected.has(node.id));
  const preview: ProcessToSubflowPreview = {
    includedNodes: selectedNodes.map(node => ({ id: node.id, label: nodeLabel(node), type: nodeType(node) })),
    attachmentCount: selectedNodes.filter(node => nodeType(node) === 'mcp' || nodeType(node) === 'resource').length,
    signalCount: selectedNodes.filter(node => nodeType(node) === 'signal').length,
    internalEdgeCount: internalEdges.length,
    inputCount: new Set(boundaryInputs.map(boundary => boundary.edgeId)).size,
    outputCount: uniqueOutputs.length,
    excludedBoundaryNodes: [...boundaryNodeIds].map(id => {
      const node = byId.get(id);
      return { id, label: nodeLabel(node), type: nodeType(node) };
    }),
    rewires: [
      pluralOr(
        tp,
        'flows.convert.rewire.inputs',
        new Set(boundaryInputs.map(boundary => boundary.edgeId)).size,
        `${new Set(boundaryInputs.map(boundary => boundary.edgeId)).size} parent input edge(s) will target the new Subflow node.`,
      ),
      uniqueOutputs.length === 1
        ? translateOr(t, 'flows.convert.rewire.output', `The parent output to ${uniqueOutputs[0].outsideLabel} will leave the new Subflow node.`, { node: uniqueOutputs[0].outsideLabel })
        : translateOr(t, 'flows.convert.rewire.noOutput', 'The new Subflow node will have no parent output.'),
      translateOr(t, 'flows.convert.rewire.childInput', 'The child Start node will provide an isolated input to the converted Process.'),
    ],
    warnings,
  };

  if (uniqueOutputs.length === 0) {
    warnings.push(translateOr(t, 'flows.convert.warning.noFollowup', 'No parent follow-up exists; the extracted fan-out will finish inside the child flow.'));
  }

  const publicInputs = boundaryInputs.map(({ edge: _edge, ...boundary }) => boundary);
  const publicOutputs = boundaryOutputs.map(({ edge: _edge, ...boundary }) => boundary);
  const baseResult = {
    valid: errors.length === 0,
    errors,
    selectedNodeIds: [...selected],
    selectedEdgeIds: internalEdges.map(edge => edge.id),
    boundaryInputs: publicInputs,
    boundaryOutputs: publicOutputs,
    preview,
  };
  if (errors.length > 0 || !target) return baseResult;

  const childId = createId();
  const startId = createId();
  const finishId = createId();
  const childEdgeId = () => `conversion-${createId()}`;
  const selectedExecutionNodes = selectedNodes.filter(node => {
    const type = nodeType(node);
    return type === 'process' || type === 'signal';
  });
  const minY = Math.min(...selectedNodes.map(node => node.position.y), target.position.y);
  const maxY = Math.max(...selectedNodes.map(node => node.position.y), target.position.y);

  const startNode: FlowNode = {
    id: startId,
    type: 'start',
    position: { x: target.position.x, y: minY - 180 },
    data: { label: 'Start Node', type: 'start', properties: { promptTemplate: '' } },
  };
  const finishNode: FlowNode = {
    id: finishId,
    type: 'finish',
    position: { x: target.position.x, y: maxY + 180 },
    data: { label: 'Finish Node', type: 'finish', properties: {} },
  };

  const childEdges: Edge[] = [
    ...internalEdges.map(edge => ({ ...edge, data: edge.data ? { ...edge.data } : edge.data })),
    makeControlEdge(childEdgeId(), startId, target.id, 'start-bottom', 'process-top'),
  ];

  if (uniqueOutputs.length === 1) {
    const output = uniqueOutputs[0];
    childEdges.push(makeControlEdge(
      childEdgeId(),
      output.insideNodeId,
      finishId,
      nodeType(byId.get(output.insideNodeId)) === 'signal' ? 'signal-bottom' : 'process-bottom',
      'finish-top',
      output.edge,
    ));
  } else {
    // With no parent successor, every selected control leaf completes at the
    // same Finish node. This is the explicit output-condensation representation
    // for parallel fan-out-only conversions.
    const leaves = selectedExecutionNodes.filter(node => !edges.some(edge => {
      if (!isControlEdge(edge)) return false;
      if (edge.source === node.id && selected.has(edge.target)) return true;
      return isBidirectional(edge) && edge.target === node.id && selected.has(edge.source);
    }));
    const effectiveLeaves = leaves.length > 0 ? leaves : [target];
    if (effectiveLeaves.length > 1) {
      warnings.push(pluralOr(tp, 'flows.convert.warning.branches', effectiveLeaves.length, `${effectiveLeaves.length} internal branches will converge on the child Finish node.`));
    }
    for (const leaf of effectiveLeaves) {
      childEdges.push(makeControlEdge(
        childEdgeId(),
        leaf.id,
        finishId,
        nodeType(leaf) === 'signal' ? 'signal-bottom' : 'process-bottom',
        'finish-top',
      ));
    }
  }

  const childFlow: Flow = {
    id: childId,
    name: trimmedName,
    description: `Converted from ${nodeLabel(target)} in ${parentFlow.name}`,
    nodes: [startNode, ...selectedNodes, finishNode],
    edges: childEdges,
  };

  const replacement: FlowNode = {
    ...target,
    type: 'subflow',
    selected: false,
    data: {
      label: trimmedName,
      type: 'subflow',
      description: `Runs the ${trimmedName} subflow`,
      properties: {
        subflowId: childId,
        inputMode: 'isolated',
        outputMode: 'final-only',
        allowCallerPrompt: true,
      },
    },
  };

  const parentNodes = nodes.filter(node => !selected.has(node.id));
  parentNodes.push(replacement);
  const parentEdges = edges.flatMap(edge => {
    const sourceSelected = selected.has(edge.source);
    const targetSelected = selected.has(edge.target);
    if (sourceSelected && targetSelected) return [];
    if (!sourceSelected && !targetSelected) return [edge];
    if (isAttachmentEdge(edge as { data?: { edgeType?: unknown } | null })) return [];
    return [{
      ...edge,
      source: sourceSelected ? replacement.id : edge.source,
      target: targetSelected ? replacement.id : edge.target,
      sourceHandle: sourceSelected ? 'subflow-bottom' : edge.sourceHandle,
      targetHandle: targetSelected ? 'subflow-top' : edge.targetHandle,
      data: edge.data ? { ...edge.data } : edge.data,
    }];
  });

  const parentDraft: Flow = {
    ...parentFlow,
    nodes: parentNodes,
    edges: parentEdges,
  };

  return {
    ...baseResult,
    valid: true,
    childFlow,
    parentFlow: parentDraft,
  };
}
