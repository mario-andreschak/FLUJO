import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import type { Flow } from '@/shared/types/flow';
import type {
  StepAgentSuggestion,
  StepAgentSuggestionResult,
  StepToolSuggestion,
  StepToolSuggestionResult,
} from '@/shared/types/flow/assistance';
import {
  MAX_VISUAL_GENERATION_DEPTH,
  type StartVisualGenerationInput,
  type VisualGenerationAgent,
  type VisualGenerationDecision,
  type VisualGenerationEvent,
  type VisualGenerationResult,
  type VisualGenerationStep,
} from '@/shared/types/flow/visualGeneration';
import { modelService } from '@/backend/services/model';
import { getCompletionAdapter, type CompletionAdapter } from '@/backend/services/model/adapters';
import { normalizeMaxTokens, type Model } from '@/shared/types/model';
import {
  applyGenerationDefaults,
  type CompileIssue,
} from '@/utils/shared/flowSpecCompiler';
import {
  compileSimpleFlowSpec,
  type SimpleFlowRoute,
  type SimpleFlowSpec,
} from '@/utils/shared/simpleFlowSpec';
import { validateFlow, type FlowValidationIssue } from '@/utils/shared/flowValidation';
import { applyStepAgentSelections } from '@/utils/shared/flowAssistance';
import { gatherGenerationContext, type GenerationContext } from './generationContext';
import {
  suggestAgentsForFlowStep,
  suggestToolsForFlowStep,
} from './assistedAuthoring';
import { flowService } from './index';
import { searchRegistry, installRegistryServer } from '@/backend/services/mcp/registryInstall';
import { loadAutoInstallSettings, appendInstallAudit } from '@/backend/services/mcp/autoInstall';
import { decideInstallConsent, planToAuditEntry } from '@/utils/mcp/autoInstallConsent';

const log = createLogger('backend/services/flow/visualGeneration');
const MAX_CONTROLLER_TURNS = 80;
const MAX_SESSION_AGENTS = 48;
const MAX_SESSION_STEPS = 160;

type Emit = (event: VisualGenerationEvent) => void;

interface PendingSuggestions {
  tools: StepToolSuggestionResult;
  agents: StepAgentSuggestionResult;
}

interface DraftStep extends VisualGenerationStep {
  acceptedAgents: Array<StepAgentSuggestion & { source: 'existing' | 'generated' }>;
}

interface DraftAgent extends Omit<VisualGenerationAgent, 'steps'> {
  steps: DraftStep[];
  routes: SimpleFlowRoute[];
  pending: Map<string, PendingSuggestions>;
}

interface InstalledServerInfo {
  name: string;
  tools: string[];
  alreadyExisted?: boolean;
  command?: string;
  args?: string[];
  verificationStatus?: string;
}

interface ControllerState {
  sessionId: string;
  description: string;
  modelId: string;
  maxDepth: number;
  allowInstall: boolean;
  agents: Map<string, DraftAgent>;
  rootAgentId: string | null;
  totalSteps: number;
  attempts: number;
  installedServers: InstalledServerInfo[];
  result: VisualGenerationResult | null;
  finishAttempts: number;
  context: GenerationContext;
  storedFlows: Flow[];
  previewRevision: number;
}

function publicStep(step: DraftStep): VisualGenerationStep {
  return {
    id: step.id,
    label: step.label,
    task: step.task,
    tools: [...step.tools],
    connectedAgentIds: [...step.connectedAgentIds],
  };
}

function publicAgent(agent: DraftAgent): VisualGenerationAgent {
  return {
    id: agent.id,
    name: agent.name,
    goal: agent.goal,
    depth: agent.depth,
    ...(agent.parentAgentId ? { parentAgentId: agent.parentAgentId } : {}),
    ...(agent.parentStepId ? { parentStepId: agent.parentStepId } : {}),
    steps: agent.steps.map(publicStep),
    status: agent.status,
  };
}

function cleanName(value: unknown, fallback: string): string {
  const text = typeof value === 'string'
    ? value.replace(/[^\p{L}\p{N}_ -]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 64).trim()
    : '';
  return text || fallback;
}

function cleanId(value: unknown, fallback: string): string {
  const text = typeof value === 'string'
    ? value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z]+/, '').slice(0, 64)
    : '';
  return text || fallback;
}

function uniqueAgentName(state: ControllerState, proposed: string): string {
  const existing = new Set([...state.agents.values()].map((agent) => agent.name.toLocaleLowerCase()));
  if (!existing.has(proposed.toLocaleLowerCase())) return proposed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${proposed.slice(0, Math.max(1, 62 - String(suffix).length)).trim()} ${suffix}`;
    if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

function getAgent(state: ControllerState, agentId: unknown): DraftAgent {
  const id = typeof agentId === 'string' ? agentId : '';
  const agent = state.agents.get(id);
  if (!agent) throw new Error(`Draft agent not found: ${id || '(missing id)'}`);
  return agent;
}

function getStep(agent: DraftAgent, stepId: unknown): DraftStep {
  const id = typeof stepId === 'string' ? stepId : '';
  const step = agent.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`Step not found in ${agent.name}: ${id || '(missing id)'}`);
  return step;
}

function simpleSpec(agent: DraftAgent, modelId: string): SimpleFlowSpec {
  return {
    profile: 'simple',
    version: 1,
    name: agent.name,
    goal: agent.goal,
    model: modelId,
    steps: agent.steps.map((step) => ({
      id: step.id,
      label: step.label,
      task: step.task,
      ...(step.tools.length ? { tools: step.tools } : {}),
    })),
    ...(agent.routes.length ? { routes: agent.routes } : {}),
  };
}

function compilePreview(
  agent: DraftAgent,
  context: GenerationContext,
  modelId: string,
): { flow: Flow; processByStep: Map<string, string>; issues: CompileIssue[] } {
  const compiled = compileSimpleFlowSpec(simpleSpec(agent, modelId), context.compile);
  if (!compiled.flow) throw new Error(`Could not create a preview for ${agent.name}`);
  compiled.flow.id = agent.id;
  applyGenerationDefaults(compiled.flow);
  const processNodes = compiled.flow.nodes.filter((node) => node.type === 'process');
  const processByStep = new Map<string, string>();
  agent.steps.forEach((step, index) => {
    const process = processNodes[index];
    if (process) processByStep.set(step.id, process.id);
  });
  return { flow: compiled.flow, processByStep, issues: compiled.issues };
}

/**
 * Compile the current partial agent into the same ReactFlow shape used by the
 * expert builder. This is deliberately best-effort: an incomplete first draft
 * must never stop the authoring controller merely because its preview cannot
 * be compiled yet.
 */
function emitAgentPreview(state: ControllerState, agent: DraftAgent, emit: Emit): void {
  try {
    const compiled = compilePreview(agent, state.context, state.modelId);
    let flow = compiled.flow;
    const generatedAgentRefs: Flow[] = [...state.agents.values()].map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      description: candidate.goal,
      nodes: [],
      edges: [],
    }));
    const availableAgents = [...state.storedFlows, ...generatedAgentRefs];
    for (const step of agent.steps) {
      const nodeId = compiled.processByStep.get(step.id);
      if (!nodeId || step.acceptedAgents.length === 0) continue;
      flow = applyStepAgentSelections(flow, {
        nodeId,
        selections: step.acceptedAgents.map(({ flowId, flowName, reason }) => ({ flowId, flowName, reason })),
        availableAgents,
      });
    }
    applyGenerationDefaults(flow);
    state.previewRevision += 1;
    emit({
      type: 'flow-preview',
      agentId: agent.id,
      flow,
      revision: state.previewRevision,
    });
  } catch (error) {
    log.debug('Partial expert preview is not compilable yet', {
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function suggestionsForStep(
  state: ControllerState,
  agent: DraftAgent,
  step: DraftStep,
): Promise<PendingSuggestions> {
  const preview = compilePreview(agent, state.context, state.modelId);
  const nodeId = preview.processByStep.get(step.id);
  if (!nodeId) throw new Error(`Could not find the preview node for ${step.label}`);
  const [tools, agents] = await Promise.all([
    suggestToolsForFlowStep({
      flow: preview.flow,
      nodeId,
      modelId: state.modelId,
      goal: agent.goal,
    }),
    suggestAgentsForFlowStep({
      flow: preview.flow,
      nodeId,
      modelId: state.modelId,
      goal: agent.goal,
    }),
  ]);
  return { tools, agents };
}

function decisionEvent(
  agentId: string,
  stepId: string,
  kind: VisualGenerationDecision['kind'],
  label: string,
  decision: VisualGenerationDecision['decision'],
  reason: string,
): VisualGenerationEvent {
  return {
    type: 'suggestion-decision',
    decision: {
      id: uuidv4(),
      agentId,
      stepId,
      kind,
      label,
      decision,
      reason,
    },
  };
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function toolDefinitions(allowInstall: boolean): OpenAI.ChatCompletionFunctionTool[] {
  const tools: OpenAI.ChatCompletionFunctionTool[] = [
    {
      type: 'function',
      function: {
        name: 'create_agent',
        description: 'Create the root draft agent or a new nested helper agent. A helper must name its parent agent and the parent process step that will call it.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'goal'],
          properties: {
            name: { type: 'string' },
            goal: { type: 'string' },
            parentAgentId: { type: 'string' },
            parentStepId: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'add_step',
        description: 'Add one visible AI task to a draft agent. FLUJO returns real connected-tool and saved-agent suggestions for this step; decide them before adding another step.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['agentId', 'stepId', 'label', 'task'],
          properties: {
            agentId: { type: 'string' },
            stepId: { type: 'string' },
            label: { type: 'string' },
            task: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'decide_suggestions',
        description: 'Accept or reject the exact tool and saved-agent suggestions returned by add_step. Omitted suggestions are treated as rejected.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['agentId', 'stepId', 'toolDecisions', 'agentDecisions'],
          properties: {
            agentId: { type: 'string' },
            stepId: { type: 'string' },
            toolDecisions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['server', 'tool', 'decision', 'reason'],
                properties: {
                  server: { type: 'string' },
                  tool: { type: 'string' },
                  decision: { type: 'string', enum: ['accepted', 'rejected'] },
                  reason: { type: 'string' },
                },
              },
            },
            agentDecisions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['flowId', 'decision', 'reason'],
                properties: {
                  flowId: { type: 'string' },
                  decision: { type: 'string', enum: ['accepted', 'rejected'] },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_step',
        description: 'Revise a visible step after validation feedback. Supply only fields that should change.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['agentId', 'stepId'],
          properties: {
            agentId: { type: 'string' },
            stepId: { type: 'string' },
            label: { type: 'string' },
            task: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_routes',
        description: 'Set non-linear routes for an agent. Omit this tool for the default linear step order.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['agentId', 'routes'],
          properties: {
            agentId: { type: 'string' },
            routes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['from', 'to'],
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  when: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind'],
                    properties: {
                      kind: { type: 'string', enum: ['contains', 'equals', 'regex', 'always'] },
                      value: { type: 'string' },
                      ignoreCase: { type: 'boolean' },
                      negate: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish_agent',
        description: 'Mark one agent ready after its steps, suggestion decisions, routes, and child agents are complete.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['agentId'],
          properties: { agentId: { type: 'string' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish_session',
        description: 'Compile and validate the entire visible draft hierarchy. If errors are returned, repair them with update_step/set_routes and call finish_session again.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_mcp_server',
        description: 'Search the public MCP registry by a short server-name term when no connected capability fits.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: { query: { type: 'string' } },
        },
      },
    },
  ];
  if (allowInstall) {
    tools.push({
      type: 'function',
      function: {
        name: 'install_mcp_server',
        description: 'Install an exact MCP registry result after the user enabled connector installation for this visual generation session.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
    });
  }
  return tools;
}

function controllerPrompt(context: GenerationContext, state: ControllerState): string {
  return `You control FLUJO's visual Guided Agent Builder through structured authoring tools.

Build the user's workflow incrementally. Every successful tool action is rendered live in the modal.

RULES:
1. Never emit ReactFlow JSON or a complete FlowSpec. Perform the work only with the supplied tools.
2. Create exactly one root agent, then add one visible step at a time.
3. After add_step, inspect its exact connected-tool and saved-agent suggestions and call decide_suggestions before continuing. Accept only suggestions that materially help; reject the rest with a short factual reason.
4. Create a new helper with create_agent when work is independently understandable, needs its own context/tools, or is genuinely reusable. A helper must reference the parent process step that calls it.
5. The user permits at most ${state.maxDepth} nested helper level(s), with the root at level 0. Decide the useful depth yourself; never add nesting just to approach the limit.
6. Build and finish a child before completing its parent. Never create parent/child cycles.
7. Keep each agent minimal and make every task directly executable. The selected model ${state.modelId} runs every process step.
8. Simple agents are linear by default. Use set_routes only for meaningful branches or conditional paths.
9. Marketplace search is allowed. ${state.allowInstall
    ? 'The user opted into connector installation for this session, so install_mcp_server is available when a missing capability is essential.'
    : 'Installation is not allowed. Never reference an unconfigured server; a marketplace result may only be noted as unavailable.'}
10. Call finish_agent for every agent, deepest first. Then call finish_session. If validation reports errors, repair them and call finish_session once more.
11. Do not stop at advice, prose, or a plan. Continue until finish_session succeeds.

CURRENT REAL BUILDING BLOCKS:
${context.catalog}`;
}

function normalizeRoutes(agent: DraftAgent, value: unknown): SimpleFlowRoute[] {
  const stepIds = new Set(agent.steps.map((step) => step.id));
  return asRecordArray(value).flatMap((entry) => {
    const from = typeof entry.from === 'string' ? entry.from : '';
    const to = typeof entry.to === 'string' ? entry.to : '';
    if (!stepIds.has(from) || !stepIds.has(to) || from === to) return [];
    const rawWhen = entry.when && typeof entry.when === 'object' && !Array.isArray(entry.when)
      ? entry.when as Record<string, unknown>
      : null;
    const kind = rawWhen?.kind;
    let when: SimpleFlowRoute['when'];
    if (rawWhen && (kind === 'contains' || kind === 'equals' || kind === 'regex' || kind === 'always')) {
      when = {
        kind,
        ...(typeof rawWhen.value === 'string' ? { value: rawWhen.value } : {}),
        ...(rawWhen.ignoreCase === true ? { ignoreCase: true } : {}),
        ...(rawWhen.negate === true ? { negate: true } : {}),
      };
    }
    return [{ from, to, ...(when ? { when } : {}) }];
  });
}

function combineIssues(compileIssues: CompileIssue[], validationIssues: FlowValidationIssue[]) {
  return [
    ...compileIssues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
    })),
    ...validationIssues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
    })),
  ];
}

async function compileSession(
  state: ControllerState,
  emit: Emit,
): Promise<VisualGenerationResult> {
  if (!state.rootAgentId) throw new Error('The visual generation session has no root agent.');
  const context = state.context;
  const storedFlows = state.storedFlows;
  const compiledById = new Map<string, Flow>();
  const processByAgentStep = new Map<string, Map<string, string>>();
  const compileIssuesByAgent = new Map<string, CompileIssue[]>();

  for (const agent of state.agents.values()) {
    agent.status = 'checking';
    emit({ type: 'agent-status', agentId: agent.id, status: 'checking' });
    const compiled = compilePreview(agent, context, state.modelId);
    compiled.flow.id = agent.id;
    compiledById.set(agent.id, compiled.flow);
    processByAgentStep.set(agent.id, compiled.processByStep);
    compileIssuesByAgent.set(agent.id, compiled.issues);
  }

  const availableAgents = [...storedFlows, ...compiledById.values()];
  for (const agent of state.agents.values()) {
    let flow = compiledById.get(agent.id)!;
    for (const step of agent.steps) {
      const processNodeId = processByAgentStep.get(agent.id)?.get(step.id);
      if (!processNodeId || step.acceptedAgents.length === 0) continue;
      flow = applyStepAgentSelections(flow, {
        nodeId: processNodeId,
        selections: step.acceptedAgents.map(({ flowId, flowName, reason }) => ({ flowId, flowName, reason })),
        availableAgents,
      });
    }
    applyGenerationDefaults(flow);
    compiledById.set(agent.id, flow);
  }

  const allIssues: Array<{ severity: string; code: string; message: string }> = [];
  for (const agent of state.agents.values()) {
    const flow = compiledById.get(agent.id)!;
    const validation = validateFlow(flow, {
      models: context.compile.models,
      servers: context.validatorServers,
      serverTools: context.compile.serverTools,
    });
    const issues = combineIssues(compileIssuesByAgent.get(agent.id) ?? [], validation.issues);
    allIssues.push(...issues.map((issue) => ({
      ...issue,
      message: `${agent.name}: ${issue.message}`,
    })));
    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    const warningCount = issues.length - errorCount;
    agent.status = errorCount > 0 ? 'needs-attention' : 'ready';
    emit({
      type: 'agent-status',
      agentId: agent.id,
      status: agent.status,
      errorCount,
      warningCount,
    });
  }

  const errorCount = allIssues.filter((issue) => issue.severity === 'error').length;
  const orderedAgents = [...state.agents.values()].sort((a, b) => b.depth - a.depth);
  const flows = orderedAgents.map((agent) => compiledById.get(agent.id)!);
  const root = compiledById.get(state.rootAgentId);
  if (!root) throw new Error('The root agent could not be compiled.');
  for (const agent of state.agents.values()) {
    const flow = compiledById.get(agent.id);
    if (!flow) continue;
    state.previewRevision += 1;
    emit({ type: 'flow-preview', agentId: agent.id, flow, revision: state.previewRevision });
  }
  return {
    flow: root,
    flows,
    rootFlowId: root.id,
    validation: {
      issues: allIssues,
      errorCount,
      warningCount: allIssues.length - errorCount,
      isRunnable: errorCount === 0,
    },
    attempts: state.attempts,
    installedServers: state.installedServers,
  };
}

async function autoRejectPending(state: ControllerState, emit: Emit): Promise<void> {
  for (const agent of state.agents.values()) {
    for (const [stepId, pending] of agent.pending) {
      for (const tool of pending.tools.suggestions) {
        emit(decisionEvent(agent.id, stepId, 'tool', `${tool.server} / ${tool.tool}`, 'rejected', 'The architect did not select this optional capability.'));
      }
      for (const candidate of pending.agents.suggestions) {
        emit(decisionEvent(agent.id, stepId, 'existing-agent', candidate.flowName, 'rejected', 'The architect kept this work inside the current agent.'));
      }
      agent.pending.delete(stepId);
    }
  }
}

async function executeAction(
  name: string,
  args: Record<string, unknown>,
  state: ControllerState,
  emit: Emit,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error('Visual generation was cancelled.');

  if (name === 'create_agent') {
    if (state.agents.size >= MAX_SESSION_AGENTS) throw new Error(`This session reached its safety budget of ${MAX_SESSION_AGENTS} agents.`);
    const parentAgentId = typeof args.parentAgentId === 'string' ? args.parentAgentId : '';
    const parentStepId = typeof args.parentStepId === 'string' ? args.parentStepId : '';
    let depth = 0;
    let parent: DraftAgent | null = null;
    let parentStep: DraftStep | null = null;
    if (parentAgentId || parentStepId) {
      if (!parentAgentId || !parentStepId) throw new Error('A helper needs both parentAgentId and parentStepId.');
      parent = getAgent(state, parentAgentId);
      parentStep = getStep(parent, parentStepId);
      depth = parent.depth + 1;
      if (depth > state.maxDepth) throw new Error(`Maximum helper nesting is ${state.maxDepth} level(s).`);
    } else if (state.rootAgentId) {
      throw new Error('The session already has a root agent; new agents must identify a parent step.');
    }
    const id = uuidv4();
    const proposedName = cleanName(args.name, parent ? 'Helper agent' : 'New agent');
    const agent: DraftAgent = {
      id,
      name: uniqueAgentName(state, proposedName),
      goal: typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim().slice(0, 20_000) : state.description,
      depth,
      ...(parent ? { parentAgentId: parent.id, parentStepId: parentStep!.id } : {}),
      steps: [],
      routes: [],
      pending: new Map(),
      status: 'building',
    };
    state.agents.set(id, agent);
    if (!state.rootAgentId) state.rootAgentId = id;
    if (parent && parentStep) {
      parentStep.connectedAgentIds.push(id);
      parentStep.acceptedAgents.push({
        flowId: id,
        flowName: agent.name,
        reason: `It handles the focused helper task: ${agent.goal}`,
        source: 'generated',
      });
      emit(decisionEvent(parent.id, parentStep.id, 'new-agent', agent.name, 'accepted', 'This work benefits from an independently reviewable helper agent.'));
      emit({ type: 'step-updated', agentId: parent.id, step: publicStep(parentStep) });
      emitAgentPreview(state, parent, emit);
    }
    emit({ type: 'agent-created', agent: publicAgent(agent) });
    emitAgentPreview(state, agent, emit);
    emit({ type: 'agent-focused', agentId: agent.id });
    return { ok: true, agentId: agent.id, depth: agent.depth, name: agent.name };
  }

  if (name === 'add_step') {
    if (state.totalSteps >= MAX_SESSION_STEPS) throw new Error(`This session reached its safety budget of ${MAX_SESSION_STEPS} steps.`);
    const agent = getAgent(state, args.agentId);
    if ([...agent.pending.keys()].length > 0) throw new Error('Decide the previous step suggestions before adding another step to this agent.');
    const baseId = cleanId(args.stepId, `step_${agent.steps.length + 1}`);
    let stepId = baseId;
    for (let suffix = 2; agent.steps.some((step) => step.id === stepId); suffix += 1) stepId = `${baseId}_${suffix}`;
    const task = typeof args.task === 'string' ? args.task.trim().slice(0, 20_000) : '';
    if (!task) throw new Error('A step needs a non-empty task.');
    const step: DraftStep = {
      id: stepId,
      label: cleanName(args.label, `Step ${agent.steps.length + 1}`),
      task,
      tools: [],
      connectedAgentIds: [],
      acceptedAgents: [],
    };
    agent.steps.push(step);
    state.totalSteps += 1;
    emit({ type: 'agent-focused', agentId: agent.id });
    emit({ type: 'step-added', agentId: agent.id, step: publicStep(step) });
    emitAgentPreview(state, agent, emit);
    emit({ type: 'activity', agentId: agent.id, stepId: step.id, message: `Checking connected capabilities for “${step.label}”…` });
    const pending = await suggestionsForStep(state, agent, step);
    agent.pending.set(step.id, pending);
    emit({
      type: 'suggestions',
      agentId: agent.id,
      stepId: step.id,
      tools: pending.tools.suggestions,
      agents: pending.agents.suggestions,
    });
    return {
      ok: true,
      agentId: agent.id,
      stepId: step.id,
      toolSuggestions: pending.tools.suggestions,
      savedAgentSuggestions: pending.agents.suggestions,
      instruction: 'Call decide_suggestions for this exact step before continuing.',
    };
  }

  if (name === 'decide_suggestions') {
    const agent = getAgent(state, args.agentId);
    const step = getStep(agent, args.stepId);
    const pending = agent.pending.get(step.id);
    if (!pending) throw new Error(`There are no pending suggestions for ${step.label}.`);
    const toolDecisions = asRecordArray(args.toolDecisions);
    const agentDecisions = asRecordArray(args.agentDecisions);
    const acceptedTools: StepToolSuggestion[] = [];
    for (const suggestion of pending.tools.suggestions) {
      const match = toolDecisions.find((entry) => entry.server === suggestion.server && entry.tool === suggestion.tool);
      const decision = match?.decision === 'accepted' ? 'accepted' : 'rejected';
      const reason = typeof match?.reason === 'string' && match.reason.trim()
        ? match.reason.trim().slice(0, 500)
        : decision === 'accepted'
          ? suggestion.reason
          : 'It is not necessary for this step.';
      if (decision === 'accepted') acceptedTools.push(suggestion);
      emit(decisionEvent(agent.id, step.id, 'tool', `${suggestion.server} / ${suggestion.tool}`, decision, reason));
    }
    if (acceptedTools.length > 0) {
      step.tools = [...new Set([...step.tools, ...acceptedTools.map((tool) => `${tool.server}/${tool.tool}`)])];
      if (pending.tools.proposedPrompt.trim()) step.task = pending.tools.proposedPrompt.trim().slice(0, 20_000);
    }
    for (const suggestion of pending.agents.suggestions) {
      const match = agentDecisions.find((entry) => entry.flowId === suggestion.flowId);
      const decision = match?.decision === 'accepted' ? 'accepted' : 'rejected';
      const reason = typeof match?.reason === 'string' && match.reason.trim()
        ? match.reason.trim().slice(0, 500)
        : decision === 'accepted'
          ? suggestion.reason
          : 'The current agent can handle this step directly.';
      if (decision === 'accepted' && !step.connectedAgentIds.includes(suggestion.flowId)) {
        step.connectedAgentIds.push(suggestion.flowId);
        step.acceptedAgents.push({ ...suggestion, reason, source: 'existing' });
      }
      emit(decisionEvent(agent.id, step.id, 'existing-agent', suggestion.flowName, decision, reason));
    }
    agent.pending.delete(step.id);
    emit({ type: 'step-updated', agentId: agent.id, step: publicStep(step) });
    emitAgentPreview(state, agent, emit);
    return {
      ok: true,
      acceptedTools: acceptedTools.map((tool) => `${tool.server}/${tool.tool}`),
      connectedAgentIds: step.connectedAgentIds,
    };
  }

  if (name === 'update_step') {
    const agent = getAgent(state, args.agentId);
    const step = getStep(agent, args.stepId);
    if (typeof args.label === 'string' && args.label.trim()) step.label = cleanName(args.label, step.label);
    if (typeof args.task === 'string' && args.task.trim()) step.task = args.task.trim().slice(0, 20_000);
    emit({ type: 'agent-focused', agentId: agent.id });
    emit({ type: 'step-updated', agentId: agent.id, step: publicStep(step) });
    emitAgentPreview(state, agent, emit);
    return { ok: true, step: publicStep(step) };
  }

  if (name === 'set_routes') {
    const agent = getAgent(state, args.agentId);
    agent.routes = normalizeRoutes(agent, args.routes);
    emit({ type: 'agent-focused', agentId: agent.id });
    emit({ type: 'routes-updated', agentId: agent.id, routes: agent.routes });
    emitAgentPreview(state, agent, emit);
    return { ok: true, routes: agent.routes };
  }

  if (name === 'finish_agent') {
    const agent = getAgent(state, args.agentId);
    if (agent.steps.length === 0) throw new Error(`${agent.name} needs at least one step.`);
    if (agent.pending.size > 0) throw new Error(`${agent.name} still has undecided suggestions.`);
    agent.status = 'ready';
    emit({ type: 'agent-status', agentId: agent.id, status: 'ready' });
    if (agent.parentAgentId) emit({ type: 'agent-focused', agentId: agent.parentAgentId });
    return { ok: true, agentId: agent.id };
  }

  if (name === 'finish_session') {
    state.finishAttempts += 1;
    await autoRejectPending(state, emit);
    const result = await compileSession(state, emit);
    if (result.validation.errorCount > 0 && state.finishAttempts === 1) {
      return {
        ok: false,
        issues: result.validation.issues.filter((issue) => issue.severity === 'error').slice(0, 20),
        instruction: 'Repair these errors with update_step or set_routes, then call finish_session again.',
      };
    }
    state.result = result;
    emit({ type: 'complete', result });
    return {
      ok: true,
      rootFlowId: result.rootFlowId,
      agentCount: result.flows.length,
      validation: result.validation,
    };
  }

  if (name === 'find_mcp_server') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const results = await searchRegistry(query);
    emit({ type: 'marketplace-results', query, count: Array.isArray(results) ? results.length : 0 });
    return results;
  }

  if (name === 'install_mcp_server') {
    if (!state.allowInstall) throw new Error('Connector installation is not enabled for this session.');
    const serverRef = typeof args.name === 'string' ? args.name.trim() : '';
    const resolved = await installRegistryServer(serverRef, undefined, { resolveOnly: true });
    const settings = await loadAutoInstallSettings();
    const decision = decideInstallConsent({
      caller: 'generator',
      settings,
      registryName: serverRef,
      allowInstall: true,
    });
    if (resolved.plan) await appendInstallAudit(planToAuditEntry(resolved.plan, 'generator', decision, false));
    const result = await installRegistryServer(serverRef);
    if (result.plan) {
      await appendInstallAudit(planToAuditEntry(result.plan, 'generator', decision, result.installed, result.error));
    }
    if (result.installed && result.serverName) {
      const installed: InstalledServerInfo = {
        name: result.serverName,
        tools: (result.tools ?? []).map((tool) => tool.name),
        ...(result.alreadyExisted ? { alreadyExisted: true } : {}),
        ...(result.plan?.command ? { command: result.plan.command } : {}),
        ...(result.plan?.args ? { args: result.plan.args } : {}),
        ...(result.plan?.verificationStatus ? { verificationStatus: result.plan.verificationStatus } : {}),
      };
      state.installedServers.push(installed);
      emit({ type: 'connector-installed', name: installed.name, tools: installed.tools, alreadyExisted: installed.alreadyExisted });
      // A newly connected server changes both the compiler catalog and the
      // expert preview's MCP-node resolution for subsequent mutations.
      state.context = await gatherGenerationContext();
    }
    return result;
  }

  throw new Error(`Unknown visual authoring action: ${name}`);
}

async function runController(
  adapter: CompletionAdapter,
  model: Model,
  apiKey: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionFunctionTool[],
  state: ControllerState,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  const localToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  for (const tool of tools) {
    if (tool.type !== 'function') continue;
    const name = tool.function.name;
    localToolExecutors[name] = async (args) => {
      try {
        return await executeAction(name, args, state, emit, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: 'activity', message: `${name}: ${message}` });
        return { ok: false, error: message };
      }
    };
  }

  for (let turn = 0; turn < MAX_CONTROLLER_TURNS && !state.result; turn += 1) {
    if (signal.aborted) throw new Error('Visual generation was cancelled.');
    state.attempts += 1;
    const { completion } = await adapter.createCompletion({
      model,
      apiKey,
      messages,
      temperature: 0,
      maxTokens: normalizeMaxTokens(model.maxTokens),
      maxTurns: MAX_CONTROLLER_TURNS,
      tools,
      localToolExecutors,
    });
    const reply = completion.choices?.[0]?.message;
    const toolCalls = reply?.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (state.result) break;
      if (state.rootAgentId && state.agents.size > 0) {
        emit({ type: 'activity', message: 'The architect stopped early; checking the visible draft before returning it.' });
        await autoRejectPending(state, emit);
        state.result = await compileSession(state, emit);
        emit({ type: 'complete', result: state.result });
        break;
      }
      const content = typeof reply?.content === 'string' ? reply.content.trim() : '';
      throw new Error(content || 'The selected model did not start the visual authoring session.');
    }

    messages.push({
      role: 'assistant',
      content: reply?.content ?? null,
      tool_calls: toolCalls,
    } as OpenAI.ChatCompletionMessageParam);
    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        // The action executor returns a useful missing-field error.
      }
      const result = await localToolExecutors[call.function.name]?.(args)
        ?? { ok: false, error: `Unknown action: ${call.function.name}` };
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  if (!state.result) {
    if (!state.rootAgentId) throw new Error('The visual architect exhausted its action budget before creating an agent.');
    emit({ type: 'activity', message: 'Action budget reached; compiling the best visible draft.' });
    await autoRejectPending(state, emit);
    state.result = await compileSession(state, emit);
    emit({ type: 'complete', result: state.result });
  }
}

/** Run one unsaved, streamed visual agent-authoring session. */
export async function generateFlowVisually(
  input: StartVisualGenerationInput,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!description) throw new Error('A workflow description is required.');
  if (!input.modelId || typeof input.modelId !== 'string') throw new Error('A generator model id is required.');
  const maxDepth = Math.max(1, Math.min(
    MAX_VISUAL_GENERATION_DEPTH,
    Number.isFinite(input.maxDepth) ? Math.floor(input.maxDepth) : MAX_VISUAL_GENERATION_DEPTH,
  ));
  const model = await modelService.getModel(input.modelId);
  if (!model) throw new Error(`Generator model not found: ${input.modelId}`);
  const resolvedKey = await modelService.resolveAndDecryptApiKey(model.ApiKey);
  const apiKey = resolvedKey || (model.adapter === 'codex-cli' && !model.ApiKey?.trim() ? '' : null);
  if (apiKey === null) throw new Error('Could not resolve the generator model API key.');
  const [context, storedFlows] = await Promise.all([
    gatherGenerationContext(),
    flowService.loadFlows(),
  ]);

  const state: ControllerState = {
    sessionId: uuidv4(),
    description,
    modelId: input.modelId,
    maxDepth,
    allowInstall: input.allowInstall === true,
    agents: new Map(),
    rootAgentId: null,
    totalSteps: 0,
    attempts: 0,
    installedServers: [],
    result: null,
    finishAttempts: 0,
    context,
    storedFlows,
    previewRevision: 0,
  };
  emit({
    type: 'session-started',
    sessionId: state.sessionId,
    maxDepth,
    message: 'Breaking the request into visible agent tasks…',
  });
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: controllerPrompt(context, state) },
    { role: 'user', content: description },
  ];
  log.info('Starting visual generation session', { sessionId: state.sessionId, modelId: input.modelId, maxDepth });
  await runController(
    getCompletionAdapter(model),
    model,
    apiKey,
    messages,
    toolDefinitions(state.allowInstall),
    state,
    emit,
    signal,
  );
}
