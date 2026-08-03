import type OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import type { Flow } from '@/shared/types/flow';
import type {
  FlowPlausibilityResult,
  PlausibilityIssue,
  StepAgentSuggestion,
  StepAgentSuggestionResult,
  StepPromptImprovementResult,
  StepToolSuggestion,
  StepToolSuggestionResult,
} from '@/shared/types/flow/assistance';
import { normalizeMaxTokens } from '@/shared/types/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { modelService } from '@/backend/services/model';
import { getSchedulerService } from '@/backend/services/scheduler';
import { resolveWaves } from '@/backend/services/waves/waveResolver';
import { validateFlow } from '@/utils/shared/flowValidation';
import { encodeBindingPill, findBindings } from '@/utils/shared/mcpBinding';
import type { EdgeCondition } from '@/utils/shared/edgeConditions';
import { buildHandoffToolNameMap } from '@/shared/utils/handoffNaming';
import {
  analyzeFlowPlausibility,
  applyStepAgentSelections,
  applyStepToolSelections,
  collectReferencedFlows,
} from '@/utils/shared/flowAssistance';
import { gatherGenerationContext } from './generationContext';
import { flowService } from './index';

const log = createLogger('backend/services/flow/assistedAuthoring');

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
}

function normalizeGeneratedFlowName(
  candidate: string,
  goal: string,
  existingNames: string[],
): string {
  const clean = (value: string) => value
    .replace(/[^\p{L}\p{N}_ -]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
  const fallback = clean(goal.split(/\s+/).slice(0, 5).join(' ')) || 'New agent';
  const base = clean(candidate) || fallback;
  const taken = new Set(existingNames.map((name) => name.trim().toLocaleLowerCase()));
  if (!taken.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = ` ${suffix}`;
    const uniqueName = `${base.slice(0, 64 - suffixText.length).trim()}${suffixText}`;
    if (!taken.has(uniqueName.toLocaleLowerCase())) return uniqueName;
  }
}

async function authoringCompletion(
  modelId: string,
  messages: OpenAI.ChatCompletionMessageParam[],
): Promise<string> {
  const model = await modelService.getModel(modelId);
  if (!model) throw new Error(`AI model not found: ${modelId}`);
  const resolvedKey = await modelService.resolveAndDecryptApiKey(model.ApiKey);
  const apiKey = resolvedKey || (model.adapter === 'codex-cli' && !model.ApiKey?.trim() ? '' : null);
  if (apiKey === null) throw new Error('Could not resolve the selected AI model credentials.');
  const adapter = getCompletionAdapter(model);
  const { completion } = await adapter.createCompletion({
    model,
    apiKey,
    messages,
    temperature: 0,
    maxTokens: normalizeMaxTokens(model.maxTokens),
    maxTurns: 1,
  });
  const content = completion.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

export async function generateFlowName(input: {
  flow: Flow;
  modelId: string;
  existingNames?: string[];
}): Promise<{ name: string }> {
  const goal = input.flow.description?.trim()
    || input.flow.nodes
      .map((node) => String(node.data.properties?.promptTemplate ?? '').trim())
      .find(Boolean)
    || '';
  let rawName = '';
  try {
    const response = await authoringCompletion(input.modelId, [
      {
        role: 'system',
        content:
          'Create a short, memorable name for this AI agent from its workflow goal. ' +
          'Use 2 to 5 words, no quotation marks, no sentence-ending punctuation, and no explanation. ' +
          'Return JSON only: {"name":"..."}.',
      },
      {
        role: 'user',
        content: JSON.stringify({ goal }),
      },
    ]);
    const parsed = extractJsonObject(response);
    rawName = typeof parsed?.name === 'string' ? parsed.name : response;
  } catch (error) {
    log.warn('AI flow-name generation failed; using a goal-derived fallback', {
      modelId: input.modelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    name: normalizeGeneratedFlowName(rawName, goal, input.existingNames ?? []),
  };
}

function compactFlowForModel(flow: Flow): unknown {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    nodes: flow.nodes.map((node) => ({
      id: node.id,
      type: node.data.type,
      label: node.data.label,
      description: node.data.description,
      prompt: node.data.properties?.promptTemplate,
      inputMode: node.data.properties?.inputMode,
      outputMode: node.data.properties?.outputMode,
      subflowId: node.data.properties?.subflowId,
      parallelSubflowIds: node.data.properties?.parallelSubflowIds,
      allowCallerPrompt: node.data.properties?.allowCallerPrompt,
      allowCallerFanout: node.data.properties?.allowCallerFanout,
      boundServer: node.data.properties?.boundServer,
      enabledTools: node.data.properties?.enabledTools,
    })),
    edges: flow.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      edgeType: (edge.data as { edgeType?: string } | undefined)?.edgeType,
      bidirectional: !!(edge.data as { bidirectional?: boolean } | undefined)?.bidirectional,
    })),
  };
}

function lexicalFallback(
  prompt: string,
  servers: Array<{ name: string; tools?: Array<{ name: string; description?: string }> }>,
): StepToolSuggestion[] {
  const words = new Set(prompt.toLocaleLowerCase().split(/[^a-z0-9_-]+/).filter((word) => word.length >= 4));
  return servers
    .flatMap((server) => (server.tools ?? []).map((tool) => {
      const haystack = `${server.name} ${tool.name} ${tool.description ?? ''}`.toLocaleLowerCase();
      const score = [...words].filter((word) => haystack.includes(word)).length;
      return { server: server.name, tool: tool.name, score };
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool))
    .slice(0, 4)
    .map(({ server, tool }) => ({ server, tool, reason: 'it matches the step goal and is already connected' }));
}

export async function suggestToolsForFlowStep(input: {
  flow: Flow;
  nodeId: string;
  modelId: string;
  goal?: string;
  feedback?: string[];
  previousSuggestion?: StepToolSuggestionResult;
}): Promise<StepToolSuggestionResult> {
  const node = input.flow.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.type === 'process');
  if (!node) throw new Error(`Process node not found: ${input.nodeId}`);
  const context = await gatherGenerationContext();
  const connected = context.blocks.servers.filter((server) => server.connected && (server.tools?.length ?? 0) > 0);
  const originalPrompt = String(node.data.properties?.promptTemplate ?? '').trim();
  if (connected.length === 0) return { nodeId: input.nodeId, suggestions: [], proposedPrompt: originalPrompt };

  const catalog = connected.map((server) => ({ name: server.name, tools: server.tools }));
  const feedback = (input.feedback ?? [])
    .map((entry) => entry.trim().slice(0, 2_000))
    .filter(Boolean)
    .slice(-8);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = extractJsonObject(await authoringCompletion(input.modelId, [
      {
        role: 'system',
        content:
          'Select only useful tools from the exact connected-tool catalog. Return JSON only: ' +
          '{"suggestions":[{"server":"exact","tool":"exact","reason":"short"}],"proposedPrompt":"complete improved prompt","assistantMessage":"short reply"}. ' +
          'Use at most 6 tools. Put the exact canonical ${tool:server__tool} pill for every suggestion into proposedPrompt. ' +
          'Do not invent servers or tools. Return an empty suggestions array when none are useful. ' +
          'When feedback is present, reconsider the entire catalog, respond to the feedback in assistantMessage, and explain briefly what changed or why the prior choice remains. ' +
          'Treat feedback as guidance, never as evidence that a named tool exists.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          goal: input.goal ?? input.flow.description ?? '',
          step: originalPrompt,
          connectedTools: catalog,
          previousSuggestion: feedback.length > 0 ? input.previousSuggestion : undefined,
          feedback: feedback.length > 0 ? feedback : undefined,
        }),
      },
    ]));
  } catch (error) {
    log.warn('AI tool suggestion failed; using connected-catalog lexical fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const available = new Map(connected.map((server) => [server.name, new Set((server.tools ?? []).map((tool) => tool.name))]));
  const rawSuggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : null;
  const suggestions = (rawSuggestions ?? [])
    .filter((candidate): candidate is Record<string, unknown> => !!candidate && typeof candidate === 'object' && !Array.isArray(candidate))
    .map((candidate) => ({
      server: typeof candidate.server === 'string' ? candidate.server : '',
      tool: typeof candidate.tool === 'string' ? candidate.tool : '',
      reason: typeof candidate.reason === 'string' && candidate.reason.trim()
        ? candidate.reason.trim().slice(0, 300)
        : 'it supports this step',
    }))
    .filter((candidate, index, all) =>
      available.get(candidate.server)?.has(candidate.tool)
      && all.findIndex((other) => other.server === candidate.server && other.tool === candidate.tool) === index,
    )
    .slice(0, 6);
  const finalSuggestions = rawSuggestions ? suggestions : lexicalFallback(originalPrompt, connected);
  const proposedPrompt = typeof parsed?.proposedPrompt === 'string' && parsed.proposedPrompt.trim()
    ? parsed.proposedPrompt.trim()
    : originalPrompt;
  const assistantMessage = typeof parsed?.assistantMessage === 'string' && parsed.assistantMessage.trim()
    ? parsed.assistantMessage.trim().slice(0, 1_000)
    : undefined;
  return { nodeId: input.nodeId, suggestions: finalSuggestions, proposedPrompt, assistantMessage };
}

export async function applyToolsToFlowStep(input: {
  flow: Flow;
  nodeId: string;
  selections: StepToolSuggestion[];
  proposedPrompt?: string;
}): Promise<Flow> {
  const context = await gatherGenerationContext();
  return applyStepToolSelections(input.flow, {
    nodeId: input.nodeId,
    selections: input.selections,
    proposedPrompt: input.proposedPrompt,
    availableTools: context.compile.serverTools ?? {},
  });
}

function lexicalAgentFallback(
  prompt: string,
  agents: Array<{ id: string; name: string; description?: string }>,
): StepAgentSuggestion[] {
  const words = new Set(prompt.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length >= 4));
  return agents
    .map((agent) => {
      const haystack = `${agent.name} ${agent.description ?? ''}`.toLocaleLowerCase();
      const score = [...words].filter((word) => haystack.includes(word)).length;
      return { ...agent, score };
    })
    .filter((agent) => agent.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 4)
    .map((agent) => ({
      flowId: agent.id,
      flowName: agent.name,
      reason: 'its saved workflow matches part of this step',
    }));
}

export async function suggestAgentsForFlowStep(input: {
  flow: Flow;
  nodeId: string;
  modelId: string;
  goal?: string;
}): Promise<StepAgentSuggestionResult> {
  const node = input.flow.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.type === 'process');
  if (!node) throw new Error(`Process node not found: ${input.nodeId}`);
  const connectedAgentIds = new Set(
    input.flow.edges
      .filter((edge) => (edge.data as { bidirectional?: boolean } | undefined)?.bidirectional === true
        && (edge.source === input.nodeId || edge.target === input.nodeId))
      .map((edge) => edge.source === input.nodeId ? edge.target : edge.source)
      .map((nodeId) => input.flow.nodes.find((candidate) => candidate.id === nodeId && candidate.data.type === 'subflow'))
      .map((candidate) => candidate?.data.properties?.subflowId)
      .filter((flowId): flowId is string => typeof flowId === 'string' && !!flowId),
  );
  const context = await gatherGenerationContext();
  const availableAgents = context.blocks.flows.filter((agent) =>
    agent.id !== input.flow.id && !connectedAgentIds.has(agent.id),
  );
  const originalPrompt = String(node.data.properties?.promptTemplate ?? '').trim();
  if (availableAgents.length === 0) return { nodeId: input.nodeId, suggestions: [] };

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = extractJsonObject(await authoringCompletion(input.modelId, [
      {
        role: 'system',
        content:
          'Select only saved agents that would materially help this workflow step. Return JSON only: ' +
          '{"suggestions":[{"flowId":"exact","reason":"short"}]}. Use at most 4 agents. ' +
          'Choose only exact ids from the supplied catalog, do not select the current workflow, and do not invent agents. ' +
          'Return an empty suggestions array when the step is better handled directly or by its connected apps.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          goal: input.goal ?? input.flow.description ?? '',
          step: originalPrompt,
          savedAgents: availableAgents,
        }),
      },
    ]));
  } catch (error) {
    log.warn('AI agent suggestion failed; using saved-agent lexical fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const availableById = new Map(availableAgents.map((agent) => [agent.id, agent]));
  const rawSuggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : null;
  const suggestions = (rawSuggestions ?? [])
    .filter((candidate): candidate is Record<string, unknown> => !!candidate && typeof candidate === 'object' && !Array.isArray(candidate))
    .map((candidate) => ({
      flowId: typeof candidate.flowId === 'string' ? candidate.flowId : '',
      reason: typeof candidate.reason === 'string' && candidate.reason.trim()
        ? candidate.reason.trim().slice(0, 300)
        : 'it can handle a focused part of this step',
    }))
    .filter((candidate, index, all) =>
      availableById.has(candidate.flowId)
      && all.findIndex((other) => other.flowId === candidate.flowId) === index,
    )
    .slice(0, 4)
    .map((candidate) => ({
      ...candidate,
      flowName: availableById.get(candidate.flowId)!.name,
    }));
  return {
    nodeId: input.nodeId,
    suggestions: rawSuggestions ? suggestions : lexicalAgentFallback(originalPrompt, availableAgents),
  };
}

export async function applyAgentsToFlowStep(input: {
  flow: Flow;
  nodeId: string;
  selections: StepAgentSuggestion[];
}): Promise<Flow> {
  const availableAgents = await flowService.loadFlows();
  return applyStepAgentSelections(input.flow, {
    nodeId: input.nodeId,
    selections: input.selections,
    availableAgents,
  });
}

interface StepHandoff {
  toolName: string;
  targetLabel: string;
  targetType: string;
  targetDescription?: string;
  targetPrompt?: string;
  edgeCondition?: EdgeCondition;
}

function stepHandoffs(flow: Flow, nodeId: string): StepHandoff[] {
  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));
  const targets: Array<{ id: string; edgeCondition?: EdgeCondition }> = [];
  const seen = new Set<string>();
  for (const edge of flow.edges) {
    const data = edge.data as { edgeType?: string; bidirectional?: boolean; condition?: EdgeCondition } | undefined;
    if (data?.edgeType === 'mcp' || data?.edgeType === 'resource') continue;
    let targetId: string | null = null;
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
    return { id, label: target.data.label, type: target.data.type || target.type };
  }));
  return targets.map(({ id, edgeCondition }) => {
    const target = nodesById.get(id)!;
    const targetPrompt = typeof target.data.properties?.promptTemplate === 'string'
      ? target.data.properties.promptTemplate.trim().slice(0, 1_000)
      : undefined;
    return {
      toolName: nameMap.get(id) || `handoff_to_${id}`,
      targetLabel: target.data.label || target.data.type || 'next step',
      targetType: target.data.type || target.type || 'node',
      ...(target.data.description?.trim()
        ? { targetDescription: target.data.description.trim().slice(0, 1_000) }
        : {}),
      ...(targetPrompt ? { targetPrompt } : {}),
      ...(edgeCondition ? { edgeCondition } : {}),
    };
  });
}

function fallbackHandoffCondition(handoff: StepHandoff): string {
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

function cleanHandoffCondition(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value
    .replace(/\s+/g, ' ')
    .replace(/[,.;:\s]+$/, '')
    .trim()
    .slice(0, 500)
    .trim();
  return clean || fallback;
}

function removeHandoffReferences(prompt: string): string {
  const matches = findBindings(prompt)
    .filter((binding) => binding.kind === 'tool' && binding.server === 'handoff')
    .sort((a, b) => b.index - a.index);
  let clean = prompt;
  for (const match of matches) {
    clean = `${clean.slice(0, match.index)}${clean.slice(match.index + match.fullMatch.length)}`;
  }
  return clean
    .replace(/\$\{handoff:[^}\r\n]+\}/g, '')
    .replace(/[ \t]+(?=\r?\n|$)/g, '')
    .trim();
}

function removeTrailingHandoffSection(prompt: string): string {
  const match = /(?:\r?\n){2,}(?:#{1,6}\s*)?handoff conditions\s*:/i.exec(prompt);
  return match ? prompt.slice(0, match.index).trim() : prompt.trim();
}

function preservePromptReferences(originalPrompt: string, improvedPrompt: string): string {
  const originalHandoffReferences = new Set(
    findBindings(originalPrompt)
      .filter((binding) => binding.kind === 'tool' && binding.server === 'handoff')
      .map((binding) => binding.fullMatch),
  );
  const references = [...new Set(originalPrompt.match(/\$\{[^}\r\n]+\}/g) ?? [])]
    .filter((reference) => !originalHandoffReferences.has(reference) && !reference.startsWith('${handoff:'));
  const missing = references.filter((reference) => !improvedPrompt.includes(reference));
  if (missing.length === 0) return improvedPrompt.trim();
  return `${improvedPrompt.trim()}\n\nRequired connected references:\n${missing.map((reference) => `- ${reference}`).join('\n')}`.trim();
}

function appendHandoffConditions(
  prompt: string,
  handoffs: StepHandoff[],
  proposedConditions: unknown,
): string {
  if (handoffs.length === 0) return prompt.trim();
  const proposedByTool = new Map<string, string>();
  if (Array.isArray(proposedConditions)) {
    for (const candidate of proposedConditions) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const entry = candidate as Record<string, unknown>;
      if (typeof entry.toolName !== 'string' || typeof entry.condition !== 'string') continue;
      if (!handoffs.some((handoff) => handoff.toolName === entry.toolName)) continue;
      proposedByTool.set(entry.toolName, entry.condition);
    }
  }
  const lines = handoffs.map((handoff) => {
    const condition = cleanHandoffCondition(
      proposedByTool.get(handoff.toolName),
      fallbackHandoffCondition(handoff),
    );
    const pill = encodeBindingPill('tool', 'handoff', handoff.toolName);
    return `- ${condition}, hand off to ${pill}.`;
  });
  return `${prompt.trim()}\n\nHandoff conditions:\n${lines.join('\n')}`.trim();
}

export async function improvePromptForFlowStep(input: {
  flow: Flow;
  nodeId: string;
  modelId: string;
  draftPrompt?: string;
}): Promise<StepPromptImprovementResult> {
  const node = input.flow.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.type === 'process');
  if (!node) throw new Error(`Process node not found: ${input.nodeId}`);
  const originalPrompt = String(node.data.properties?.promptTemplate ?? '').trim();
  const handoffs = stepHandoffs(input.flow, input.nodeId);
  const attachedEdges = input.flow.edges
    .filter((edge) => edge.source === input.nodeId || edge.target === input.nodeId);
  const attachedNodeIds = new Set(
    attachedEdges.map((edge) => edge.source === input.nodeId ? edge.target : edge.source),
  );
  const agentNodeIds = new Set(
    attachedEdges
      .filter((edge) => (edge.data as { bidirectional?: boolean } | undefined)?.bidirectional === true)
      .map((edge) => edge.source === input.nodeId ? edge.target : edge.source),
  );
  const attachedNodes = input.flow.nodes.filter((candidate) => attachedNodeIds.has(candidate.id));
  const apps = attachedNodes
    .filter((candidate) => candidate.data.type === 'mcp')
    .map((candidate) => ({
      server: candidate.data.properties?.boundServer,
      tools: candidate.data.properties?.enabledTools,
    }));
  const agents = attachedNodes
    .filter((candidate) => candidate.data.type === 'subflow' && agentNodeIds.has(candidate.id))
    .map((candidate) => ({
      flowId: candidate.data.properties?.subflowId,
      name: candidate.data.label,
      description: candidate.data.description,
    }));
  const parsed = extractJsonObject(await authoringCompletion(input.modelId, [
    {
      role: 'system',
      content:
        'Rewrite one workflow-step prompt so it is clear, complete, and directly executable. Return JSON only: ' +
        '{"prompt":"main prompt without a handoff section","handoffConditions":[{"toolName":"exact supplied name","condition":"If/when condition only"}]}. ' +
        'Preserve every non-handoff ${...} reference exactly, including connected app tools, variables, and resources. ' +
        'Explain when to use relevant connected capabilities, but do not invent capabilities, identifiers, facts, or user requirements. ' +
        'For every supplied handoff, return exactly one concise, mutually understandable routing condition using its exact toolName. ' +
        'Infer conditions from the step goal, target purpose, and any configured edge condition. Return only the condition in each condition field; ' +
        'do not include a handoff pill or "hand off to" there. Do not put handoff conditions in prompt; FLUJO appends the validated section itself. ' +
        'Keep the user intent and output expectations intact.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        workflowGoal: input.flow.description ?? '',
        stepName: node.data.label,
        currentPrompt: originalPrompt,
        draftPrompt: input.draftPrompt?.trim() || undefined,
        connectedApps: apps,
        connectedAgents: agents,
        handoffs,
      }),
    },
  ]));
  const candidate = typeof parsed?.prompt === 'string' && parsed.prompt.trim()
    ? parsed.prompt.trim().slice(0, 20_000)
    : originalPrompt;
  const withoutHandoffs = removeTrailingHandoffSection(removeHandoffReferences(candidate));
  const withPreservedReferences = preservePromptReferences(originalPrompt, withoutHandoffs);
  return {
    nodeId: input.nodeId,
    prompt: appendHandoffConditions(withPreservedReferences, handoffs, parsed?.handoffConditions),
  };
}

async function semanticPlausibilityIssues(
  flows: Array<{ flow: Flow; contexts: FlowPlausibilityResult['contexts'] }>,
  modelId: string,
): Promise<PlausibilityIssue[]> {
  try {
    const parsed = extractJsonObject(await authoringCompletion(modelId, [
      {
        role: 'system',
        content:
          'Review this workflow for semantic plausibility. Read every prompt, graph connection, input/output mode, and invocation context. ' +
          'Focus on missing information between steps, prompts that contradict chat vs headless execution, tools that do not support the task, ' +
          'and subflow call semantics. Return JSON only: {"issues":[{"severity":"warning|error","code":"semantic-*","message":"...","flowId":"exact id","nodeId":"optional exact id"}]}. ' +
          'Do not propose arbitrary graph JSON and do not repeat obvious style advice. Maximum 8 issues.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          flows: flows.map(({ flow, contexts }) => ({ contexts, flow: compactFlowForModel(flow) })),
        }),
      },
    ]));
    const validFlowIds = new Set(flows.map(({ flow }) => flow.id));
    const validNodeIds = new Map(flows.map(({ flow }) => [flow.id, new Set(flow.nodes.map((node) => node.id))]));
    return (Array.isArray(parsed?.issues) ? parsed.issues : [])
      .filter((issue): issue is Record<string, unknown> => !!issue && typeof issue === 'object' && !Array.isArray(issue))
      .map((issue) => ({
        severity: issue.severity === 'error' ? 'error' as const : 'warning' as const,
        code: typeof issue.code === 'string' && issue.code.startsWith('semantic-') ? issue.code : 'semantic-plausibility',
        message: typeof issue.message === 'string' ? issue.message.slice(0, 800) : '',
        ...(typeof issue.flowId === 'string' && validFlowIds.has(issue.flowId) ? { flowId: issue.flowId } : {}),
        ...(typeof issue.nodeId === 'string'
          && typeof issue.flowId === 'string'
          && validNodeIds.get(issue.flowId)?.has(issue.nodeId)
          ? { nodeId: issue.nodeId }
          : {}),
      }))
      .filter((issue) => !!issue.message)
      .slice(0, 8);
  } catch (error) {
    log.warn('Semantic plausibility call failed; returning deterministic analysis only', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function checkFlowPlausibility(input: {
  flow: Flow;
  relatedFlows?: Flow[];
  modelId?: string;
  intendedContext?: 'chat' | 'headless';
}): Promise<FlowPlausibilityResult> {
  const stored = await flowService.loadFlows();
  // Later entries win so unsaved root/descendant drafts are analyzed instead
  // of stale persisted copies with the same ids.
  const flowById = new Map<string, Flow>();
  for (const flow of stored) flowById.set(flow.id, flow);
  for (const flow of input.relatedFlows ?? []) flowById.set(flow.id, flow);
  flowById.set(input.flow.id, input.flow);
  const allFlows = [...flowById.values()];
  const executionEntries = await getSchedulerService().list().catch(() => []);
  const executions = executionEntries.map((entry) => entry.execution);
  const waves = resolveWaves({ executions: executionEntries, flows: allFlows });
  const waveExecutions = new Map<string, string>();
  for (const wave of waves.waves) {
    for (const node of wave.nodes) waveExecutions.set(node.executionId, `Trigger Wave ${wave.id}: ${node.name}`);
  }
  const inspected = collectReferencedFlows(input.flow, allFlows);
  const analyzed = inspected.map((flow) => analyzeFlowPlausibility(flow, {
    allFlows,
    plannedExecutions: executions,
    waveExecutions,
    intendedContext: flow.id === input.flow.id ? input.intendedContext : undefined,
  }));
  const repairedFlows = analyzed.map((result) => result.repairedFlow);
  const repairedFlow = repairedFlows.find((flow) => flow.id === input.flow.id) ?? input.flow;
  const contexts = analyzed.flatMap((result) => result.contexts).filter((context, index, all) =>
    all.findIndex((candidate) => candidate.kind === context.kind
      && candidate.sourceId === context.sourceId
      && candidate.label === context.label) === index,
  );
  const deterministicIssues = analyzed.flatMap((result) => result.issues);
  const patches = analyzed.flatMap((result) => result.patches);
  const context = await gatherGenerationContext();
  const structural = repairedFlows.flatMap((flow) => validateFlow(flow, {
      models: context.compile.models,
      servers: context.validatorServers,
      serverTools: context.compile.serverTools,
    }).issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      flowId: flow.id,
      ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
    })));
  const semantic = input.modelId
    ? await semanticPlausibilityIssues(
      repairedFlows.map((flow, index) => ({ flow, contexts: analyzed[index].contexts })),
      input.modelId,
    )
    : [];
  return {
    contexts,
    issues: [...deterministicIssues, ...structural, ...semantic],
    patches,
    repairedFlow,
    repairedFlows,
  };
}
