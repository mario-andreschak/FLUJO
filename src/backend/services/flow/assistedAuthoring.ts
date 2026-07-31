import type OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import type { Flow } from '@/shared/types/flow';
import type {
  FlowPlausibilityResult,
  PlausibilityIssue,
  StepToolSuggestion,
  StepToolSuggestionResult,
} from '@/shared/types/flow/assistance';
import { normalizeMaxTokens } from '@/shared/types/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { modelService } from '@/backend/services/model';
import { getSchedulerService } from '@/backend/services/scheduler';
import { resolveWaves } from '@/backend/services/waves/waveResolver';
import { validateFlow } from '@/utils/shared/flowValidation';
import {
  analyzeFlowPlausibility,
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
}): Promise<StepToolSuggestionResult> {
  const node = input.flow.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.type === 'process');
  if (!node) throw new Error(`Process node not found: ${input.nodeId}`);
  const context = await gatherGenerationContext();
  const connected = context.blocks.servers.filter((server) => server.connected && (server.tools?.length ?? 0) > 0);
  const originalPrompt = String(node.data.properties?.promptTemplate ?? '').trim();
  if (connected.length === 0) return { nodeId: input.nodeId, suggestions: [], proposedPrompt: originalPrompt };

  const catalog = connected.map((server) => ({ name: server.name, tools: server.tools }));
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = extractJsonObject(await authoringCompletion(input.modelId, [
      {
        role: 'system',
        content:
          'Select only useful tools from the exact connected-tool catalog. Return JSON only: ' +
          '{"suggestions":[{"server":"exact","tool":"exact","reason":"short"}],"proposedPrompt":"complete improved prompt"}. ' +
          'Use at most 6 tools. Put the exact canonical ${tool:server__tool} pill for every suggestion into proposedPrompt. ' +
          'Do not invent servers or tools. Return an empty suggestions array when none are useful.',
      },
      {
        role: 'user',
        content: JSON.stringify({ goal: input.goal ?? input.flow.description ?? '', step: originalPrompt, connectedTools: catalog }),
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
  return { nodeId: input.nodeId, suggestions: finalSuggestions, proposedPrompt };
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
