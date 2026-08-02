import { v4 as uuidv4 } from 'uuid';
import type { Edge } from '@xyflow/react';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type {
  FlowPlausibilityResult,
  FlowUsageContext,
  PlausibilityIssue,
  PlausibilityPatch,
  StepToolSuggestion,
} from '@/shared/types/flow/assistance';
import { encodeBindingPill, findBindings } from './mcpBinding';

export interface ApplyStepToolsOptions {
  nodeId: string;
  selections: StepToolSuggestion[];
  availableTools: Record<string, string[]>;
  proposedPrompt?: string;
}

function cloneFlow(flow: Flow): Flow {
  return JSON.parse(JSON.stringify(flow)) as Flow;
}

function edgeType(edge: Edge): string | undefined {
  return (edge.data as { edgeType?: string } | undefined)?.edgeType;
}

function attachedMcpNodes(flow: Flow, processNodeId: string): FlowNode[] {
  const ids = new Set(
    flow.edges
      .filter((edge) => edgeType(edge) === 'mcp' && (edge.source === processNodeId || edge.target === processNodeId))
      .map((edge) => edge.source === processNodeId ? edge.target : edge.source),
  );
  return flow.nodes.filter((node) => ids.has(node.id) && node.data.type === 'mcp');
}

function ensurePills(prompt: string, selections: StepToolSuggestion[]): string {
  const existing = new Set(
    findBindings(prompt)
      .filter((binding) => binding.kind === 'tool')
      .map((binding) => `${binding.server}\u0000${binding.name}`),
  );
  const missing = selections.filter((selection) => !existing.has(`${selection.server}\u0000${selection.tool}`));
  if (missing.length === 0) return prompt.trim();
  const lines = missing.map((selection) =>
    `- Use ${encodeBindingPill('tool', selection.server, selection.tool)} when ${selection.reason.replace(/[.\s]+$/, '')}.`,
  );
  return `${prompt.trim()}\n\nAvailable connected tools:\n${lines.join('\n')}`.trim();
}

function removeUnapprovedNewToolPills(
  proposedPrompt: string,
  originalPrompt: string,
  approved: StepToolSuggestion[],
): string {
  const keep = new Set([
    ...findBindings(originalPrompt)
      .filter((binding) => binding.kind === 'tool')
      .map((binding) => `${binding.server}\u0000${binding.name}`),
    ...approved.map((selection) => `${selection.server}\u0000${selection.tool}`),
  ]);
  const removable = findBindings(proposedPrompt)
    .filter((binding) => binding.kind === 'tool' && !keep.has(`${binding.server}\u0000${binding.name}`))
    .sort((a, b) => b.index - a.index);
  let clean = proposedPrompt;
  for (const binding of removable) {
    clean = `${clean.slice(0, binding.index)}${clean.slice(binding.index + binding.fullMatch.length)}`;
  }
  return clean.replace(/[ \t]+(?=\r?\n|$)/g, '').trim();
}

/**
 * Apply an already-approved set of connected tools to one Process node.
 * The operation is deterministic and idempotent: a server has at most one MCP
 * attachment per Process node and every canonical tool pill appears at most once.
 */
export function applyStepToolSelections(flow: Flow, options: ApplyStepToolsOptions): Flow {
  const next = cloneFlow(flow);
  const processNode = next.nodes.find((node) => node.id === options.nodeId && node.data.type === 'process');
  if (!processNode) throw new Error(`Process node not found: ${options.nodeId}`);

  const approved = options.selections.filter((selection, index, all) =>
    Array.isArray(options.availableTools[selection.server])
    && options.availableTools[selection.server].includes(selection.tool)
    && all.findIndex((candidate) => candidate.server === selection.server && candidate.tool === selection.tool) === index,
  );
  if (approved.length === 0) return next;

  const byServer = new Map<string, StepToolSuggestion[]>();
  for (const selection of approved) {
    byServer.set(selection.server, [...(byServer.get(selection.server) ?? []), selection]);
  }

  const attached = attachedMcpNodes(next, processNode.id);
  let offset = attached.length;
  for (const [server, selections] of byServer) {
    let mcpNode = attached.find((node) => node.data.properties?.boundServer === server);
    if (!mcpNode) {
      mcpNode = {
        id: uuidv4(),
        type: 'mcp',
        position: { x: processNode.position.x + 350, y: processNode.position.y + offset * 120 },
        data: { label: server, type: 'mcp', properties: { boundServer: server, enabledTools: [] } },
      };
      offset += 1;
      next.nodes.push(mcpNode);
      next.edges.push({
        id: `${processNode.id}:process-right-mcp->${mcpNode.id}:mcp-left`,
        source: processNode.id,
        sourceHandle: 'process-right-mcp',
        target: mcpNode.id,
        targetHandle: 'mcp-left',
        type: 'mcpEdge',
        data: { edgeType: 'mcp' },
        animated: false,
        markerEnd: { type: 'arrowclosed', width: 20, height: 20, color: '#1976d2' },
        markerStart: { type: 'arrowclosed', width: 20, height: 20, color: '#1976d2' },
        style: { stroke: '#1976d2', strokeWidth: 2 },
      });
      attached.push(mcpNode);
    }
    const current = Array.isArray(mcpNode.data.properties?.enabledTools)
      ? mcpNode.data.properties!.enabledTools.filter((tool: unknown): tool is string => typeof tool === 'string')
      : [];
    mcpNode.data.properties = {
      ...(mcpNode.data.properties ?? {}),
      boundServer: server,
      enabledTools: [...new Set([...current, ...selections.map((selection) => selection.tool)])],
    };
  }

  const originalPrompt = typeof processNode.data.properties?.promptTemplate === 'string'
    ? processNode.data.properties.promptTemplate
    : '';
  const approvedPrompt = removeUnapprovedNewToolPills(
    options.proposedPrompt?.trim() || originalPrompt,
    originalPrompt,
    approved,
  );
  processNode.data.properties = {
    ...(processNode.data.properties ?? {}),
    promptTemplate: ensurePills(approvedPrompt, approved),
  };
  return next;
}

export interface PlausibilityContextInput {
  allFlows?: Flow[];
  plannedExecutions?: Array<{ id: string; name: string; flowId: string; trigger?: { type?: string } }>;
  waveExecutions?: Map<string, string>;
  intendedContext?: 'chat' | 'headless';
}

/** Root-first, cycle-safe closure of every subflow referenced by a Flow bundle. */
export function collectReferencedFlows(root: Flow, allFlows: Flow[]): Flow[] {
  const byId = new Map(allFlows.map((flow) => [flow.id, flow]));
  byId.set(root.id, root);
  const collected: Flow[] = [];
  const visited = new Set<string>();
  const visit = (flow: Flow) => {
    if (visited.has(flow.id)) return;
    visited.add(flow.id);
    collected.push(flow);
    for (const node of flow.nodes.filter((candidate) => candidate.data.type === 'subflow')) {
      const props = node.data.properties ?? {};
      const targetIds = [
        typeof props.subflowId === 'string' ? props.subflowId : '',
        ...(Array.isArray(props.parallelSubflowIds)
          ? props.parallelSubflowIds.filter((id): id is string => typeof id === 'string')
          : []),
      ];
      for (const targetId of targetIds) {
        const child = byId.get(targetId);
        if (child) visit(child);
      }
    }
  };
  visit(root);
  return collected;
}

function controlEdges(flow: Flow): Edge[] {
  return flow.edges.filter((edge) => edgeType(edge) !== 'mcp' && edgeType(edge) !== 'resource');
}

export function inferFlowUsageContexts(flow: Flow, input: PlausibilityContextInput = {}): FlowUsageContext[] {
  const contexts: FlowUsageContext[] = [];
  const allFlows = input.allFlows ?? [];
  for (const parent of allFlows) {
    for (const node of parent.nodes.filter((candidate) => candidate.data.type === 'subflow')) {
      const props = node.data.properties ?? {};
      const targets = [props.subflowId, ...(Array.isArray(props.parallelSubflowIds) ? props.parallelSubflowIds : [])];
      if (!targets.includes(flow.id)) continue;
      const isSubagent = parent.edges.some((edge) =>
        !!(edge.data as { bidirectional?: boolean } | undefined)?.bidirectional
        && (edge.source === node.id || edge.target === node.id)
        && parent.nodes.some((candidate) =>
          candidate.data.type === 'process'
          && (candidate.id === edge.source || candidate.id === edge.target),
        ),
      );
      contexts.push({
        kind: isSubagent ? 'subagent' : 'subflow-chain',
        label: `${isSubagent ? 'Sub-agent' : 'Subflow'} of ${parent.name}`,
        sourceId: parent.id,
      });
    }
  }
  for (const execution of input.plannedExecutions ?? []) {
    if (execution.flowId !== flow.id) continue;
    contexts.push({
      kind: input.waveExecutions?.has(execution.id) ? 'trigger-wave' : 'planned-execution',
      label: input.waveExecutions?.get(execution.id) ?? `${execution.name} (${execution.trigger?.type ?? 'trigger'})`,
      sourceId: execution.id,
    });
  }
  if (input.intendedContext === 'headless'
    && !contexts.some((context) => context.kind === 'planned-execution' || context.kind === 'trigger-wave')) {
    contexts.push({ kind: 'planned-execution', label: 'Headless / triggered run' });
  }
  if (contexts.length === 0 || input.intendedContext === 'chat') {
    contexts.push({ kind: 'chat', label: 'Chat / direct run' });
  }
  return contexts.filter((context, index, all) =>
    all.findIndex((candidate) => candidate.kind === context.kind && candidate.sourceId === context.sourceId) === index,
  );
}

function patchNode(
  flow: Flow,
  node: FlowNode,
  desired: Record<string, unknown>,
  remove: string[],
  reason: string,
  issues: PlausibilityIssue[],
  patches: PlausibilityPatch[],
): void {
  const properties = { ...(node.data.properties ?? {}) };
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (properties[key] !== value) set[key] = value;
  }
  const actualRemove = remove.filter((key) => properties[key] !== undefined);
  if (Object.keys(set).length === 0 && actualRemove.length === 0) return;
  patches.push({ flowId: flow.id, nodeId: node.id, set, remove: actualRemove, reason });
  issues.push({ severity: 'warning', code: 'assisted-io-policy', message: reason, flowId: flow.id, nodeId: node.id });
  for (const [key, value] of Object.entries(set)) properties[key] = value;
  for (const key of actualRemove) delete properties[key];
  node.data.properties = properties;
}

/** Pure deterministic plausibility policy and repair preview. */
export function analyzeFlowPlausibility(
  flow: Flow,
  input: PlausibilityContextInput = {},
): FlowPlausibilityResult {
  const repairedFlow = cloneFlow(flow);
  const issues: PlausibilityIssue[] = [];
  const patches: PlausibilityPatch[] = [];
  const contexts = inferFlowUsageContexts(flow, input);
  const edges = controlEdges(repairedFlow);
  const processCount = repairedFlow.nodes.filter((node) => node.data.type === 'process').length;

  for (const node of repairedFlow.nodes) {
    if (node.data.type === 'process') {
      const desired: Record<string, unknown> = { inputMode: 'full-history' };
      if (processCount <= 3) desired.outputMode = 'latest-message';
      patchNode(
        repairedFlow,
        node,
        desired,
        ['isolatedPrompt'],
        processCount <= 3
          ? `Process step "${node.data.label}" should receive the full conversation and expose only its final message in this small flow.`
          : `Process step "${node.data.label}" should receive the full conversation; latest-message and isolated inputs are avoided.`,
        issues,
        patches,
      );
      continue;
    }
    if (node.data.type !== 'subflow') continue;
    const subagent = edges.some((edge) => {
      if (!(edge.data as { bidirectional?: boolean } | undefined)?.bidirectional) return false;
      const otherId = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : '';
      return repairedFlow.nodes.some((candidate) => candidate.id === otherId && candidate.data.type === 'process');
    });
    if (subagent) {
      patchNode(
        repairedFlow,
        node,
        { inputMode: 'isolated', outputMode: 'final-only' },
        ['promptTemplate', 'isolatedPrompt', 'spawnBriefs'],
        `Sub-agent "${node.data.label}" should receive queued caller tasks and return only its final message.`,
        issues,
        patches,
      );
    } else {
      patchNode(
        repairedFlow,
        node,
        { inputMode: 'full-history', outputMode: 'final-only' },
        ['promptTemplate', 'isolatedPrompt'],
        `Chained subflow "${node.data.label}" should continue with the full conversation and return only its final message.`,
        issues,
        patches,
      );
    }
  }

  const headless = contexts.some((context) => context.kind === 'planned-execution' || context.kind === 'trigger-wave');
  if (headless) {
    const interactive = repairedFlow.nodes.filter((node) =>
      node.data.type === 'process'
      && /\b(ask the user|wait for (?:the )?user|clarif(?:y|ication)|confirm with the user)\b/i.test(
        String(node.data.properties?.promptTemplate ?? ''),
      ),
    );
    for (const node of interactive) {
      issues.push({
        severity: 'warning',
        code: 'headless-interaction-assumption',
        message: `"${node.data.label}" appears to require an interactive user, but this flow runs from a trigger or Wave.`,
        flowId: repairedFlow.id,
        nodeId: node.id,
      });
    }
  }

  return { contexts, issues, patches, repairedFlow, repairedFlows: [repairedFlow] };
}
