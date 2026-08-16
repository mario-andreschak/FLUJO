import { withWorkspaceRoute } from '@/app/api/_workspace';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { materializeModelInput } from '@/backend/execution/flow/materializeModelInput';
import { formatTodoBlock } from '@/backend/execution/flow/handlers/todoTool';
import type {
  ProcessNodeParams,
  ProcessNodeProperties,
  SharedState,
  WirePreviewResponse,
  WirePreviewUnavailableReason,
  WirePreviewWarning,
} from '@/backend/execution/flow/types';
import { flowService } from '@/backend/services/flow';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { Flow } from '@/shared/types/flow';
import { resolveRunVars } from '@/utils/shared/resolveRunVars';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ conversationId: string }> };

function jsonNoStore(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function unavailable(
  conversationId: string,
  nodeId: string,
  reason: WirePreviewUnavailableReason,
  state?: Readonly<SharedState>,
): NextResponse {
  return jsonNoStore({
    status: 'unavailable',
    mode: 'current-preview',
    conversationId,
    rootConversationId: state?.rootConversationId ?? null,
    parentConversationId: state?.parentConversationId ?? null,
    nodeId,
    warnings: [],
    unavailableReason: reason,
  } satisfies WirePreviewResponse);
}

interface Lineage {
  ids: Set<string>;
  rootId: string;
}

async function loadLineage(conversationId: string): Promise<Lineage | null> {
  const ids = new Set<string>();
  const declaredRoots = new Set<string>();
  let currentId: string | undefined = conversationId;

  for (let depth = 0; currentId && depth < 64; depth++) {
    if (ids.has(currentId)) return null;
    ids.add(currentId);
    const state = await loadConversationStateReadOnly(currentId);
    if (!state) return null;
    if (state.rootConversationId) declaredRoots.add(state.rootConversationId);
    if (!state.parentConversationId) {
      if ([...declaredRoots].some(rootId => rootId !== currentId)) return null;
      return { ids, rootId: currentId };
    }
    currentId = state.parentConversationId;
  }
  return null;
}

async function isAuthorizedScope(
  requestedId: string,
  targetId: string,
): Promise<boolean> {
  if (requestedId === targetId) return true;
  const [requested, target] = await Promise.all([
    loadLineage(requestedId),
    loadLineage(targetId),
  ]);
  if (!requested || !target || requested.rootId !== target.rootId) return false;
  return [...requested.ids].some(id => target.ids.has(id));
}

function processParamsFromFlowNode(
  node: Flow['nodes'][number],
): ProcessNodeParams {
  return {
    id: node.id,
    label: String(node.data?.label ?? node.id),
    type: 'process',
    properties: {
      ...((node.data?.properties ?? {}) as ProcessNodeProperties),
    },
  };
}

function hasUnsupportedReferences(value: unknown): boolean {
  return typeof value === 'string'
    && (value.includes('${res:') || value.includes('${kv:'));
}

function sanitizeMessage(message: FlujoChatMessage): FlujoChatMessage {
  if (!message.media?.length) return message;
  return {
    ...message,
    media: message.media.map(({ localPath: _localPath, ...part }) => part),
  } as FlujoChatMessage;
}

async function buildPreviewSystemPrompt(
  state: Readonly<SharedState>,
  flow: Flow,
  node: ProcessNodeParams,
): Promise<{ content: string; warnings: WirePreviewWarning[] }> {
  const warnings: WirePreviewWarning[] = [];
  const properties = node.properties ?? {};
  let rendered = await promptRenderer.renderPrompt(flow.id, node.id, {
    renderMode: 'rendered',
    includeConversationHistory: false,
    excludeModelPrompt: properties.excludeModelPrompt ?? false,
    excludeStartNodePrompt: properties.excludeStartNodePrompt ?? false,
    excludeSystemPrompt: properties.excludeSystemPrompt ?? false,
    flowSnapshot: flow,
  });

  const personaContext = state.personaInstructionContext;
  const attribution = state.personaAttribution;
  if (
    personaContext
    && attribution
    && personaContext.personaId === attribution.personaId
    && personaContext.activityId === attribution.activityId
    && personaContext.behaviorRevisionId === attribution.behaviorRevisionId
    && personaContext.rootFlowId === flow.id
  ) {
    rendered = personaContext.instruction + '\n\n' + rendered;
  }

  const content = resolveRunVars(rendered, state.variables);
  const omittedResourceWork = hasUnsupportedReferences(content)
    || (properties.resourceNodes?.length ?? 0) > 0;
  if (omittedResourceWork) {
    warnings.push({
      code: 'resource_resolution_omitted',
      message: 'Run-resource, KV, and resource-node expansion is omitted from this read-only preview.',
    });
  }
  return { content, warnings };
}

async function POST_handler(
  request: NextRequest,
  { params }: RouteContext,
): Promise<NextResponse> {
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;

  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId } = await params;
  let body: { nodeId?: unknown; targetConversationId?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonNoStore({ error: 'Invalid JSON body' }, 400);
  }

  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
  const targetConversationId =
    typeof body.targetConversationId === 'string' && body.targetConversationId.trim()
      ? body.targetConversationId.trim()
      : conversationId;
  if (!nodeId) return jsonNoStore({ error: 'nodeId is required' }, 400);

  const requestedState = await loadConversationStateReadOnly(conversationId);
  if (!requestedState) {
    return unavailable(conversationId, nodeId, 'missing_history');
  }
  if (!(await isAuthorizedScope(conversationId, targetConversationId))) {
    return unavailable(conversationId, nodeId, 'scope_mismatch', requestedState);
  }

  const targetState = targetConversationId === conversationId
    ? requestedState
    : await loadConversationStateReadOnly(targetConversationId);
  if (!targetState || !Array.isArray(targetState.messages)) {
    return unavailable(targetConversationId, nodeId, 'missing_history', targetState);
  }

  const flow = targetState.flowSnapshot ?? await flowService.getFlow(targetState.flowId);
  if (!flow) return unavailable(targetConversationId, nodeId, 'missing_node', targetState);

  const flowNode = flow.nodes.find(candidate => candidate.id === nodeId);
  if (!flowNode) return unavailable(targetConversationId, nodeId, 'missing_node', targetState);
  if (flowNode.type !== 'process' && flowNode.data?.type !== 'process') {
    return unavailable(targetConversationId, nodeId, 'non_process_node', targetState);
  }

  const node = processParamsFromFlowNode(flowNode);
  const prompt = await buildPreviewSystemPrompt(targetState, flow, node);
  const inputMode = node.properties.inputMode ?? 'full-history';
  const allowCallerPrompt = node.properties.allowCallerPrompt !== false;
  const callerPrompt = allowCallerPrompt
    && targetState.handoffInput?.targetNodeId === nodeId
      ? targetState.handoffInput.prompt?.trim()
      : undefined;
  const isolatedPrompt = resolveRunVars(
    callerPrompt || node.properties.isolatedPrompt || '',
    targetState.variables,
  );

  const collapsedNodeIds = new Set(
    flow.nodes
      .filter(candidate =>
        (candidate.type === 'process' || candidate.data?.type === 'process')
        && candidate.data?.properties?.outputMode === 'latest-message')
      .map(candidate => candidate.id),
  );
  const systemMessage: FlujoChatMessage = {
    id: `wire-preview-system-${nodeId}`,
    role: 'system',
    content: prompt.content,
    timestamp: 0,
  };
  const todoBlock = node.properties.enableTodoTool
    ? formatTodoBlock(targetState.todos ?? [])
    : '';
  const additionalWireMessages: FlujoChatMessage[] = todoBlock
    ? [{
        id: `wire-preview-todo-${nodeId}`,
        role: 'user',
        content: todoBlock,
        timestamp: 0,
      }]
    : [];

  const canonicalMessages = targetState.messages.filter(
    message => (message.depth ?? 0) === 0,
  );
  const omittedNestedCount = targetState.messages.length - canonicalMessages.length;
  const materialized = materializeModelInput({
    canonicalMessages,
    systemMessage,
    systemContent: prompt.content,
    collapsedNodeIds,
    inputMode,
    isolatedPrompt,
    mcpAppContexts: targetState.mcpAppContexts,
    additionalWireMessages,
  });

  const warnings: WirePreviewWarning[] = [
    {
      code: 'current_state',
      message: 'This is a predictive preview built from the current conversation and flow configuration.',
    },
    {
      code: 'provider_finalization_omitted',
      message: 'Provider sessions, write-capable compaction, and adapter invocation are not performed for previews.',
    },
    ...prompt.warnings,
  ];
  if (
    canonicalMessages.some(message =>
      typeof message.content === 'string'
      && (message.content.includes('${') || message.content.includes('@')))
  ) {
    warnings.push({
      code: 'resource_resolution_omitted',
      message: 'Dynamic chat-message references remain literal in this read-only preview.',
    });
  }
  if (
    (node.properties.mcpNodes?.length ?? 0) > 0
    || (node.properties.allowedTools?.length ?? 0) > 0
  ) {
    warnings.push({
      code: 'tool_configuration_omitted',
      message: 'Tool discovery and tool configuration are intentionally excluded from preview generation.',
    });
  }
  if (omittedNestedCount > 0) {
    warnings.push({
      code: 'history_projection_omitted',
      message: 'Display-only nested subflow messages were excluded from this conversation scope.',
    });
  }

  const snapshot = {
    ...materialized.snapshot,
    wireMessages: materialized.snapshot.wireMessages.map(sanitizeMessage),
  };
  return jsonNoStore({
    status: 'available',
    mode: 'current-preview',
    conversationId: targetConversationId,
    rootConversationId: targetState.rootConversationId ?? null,
    parentConversationId: targetState.parentConversationId ?? null,
    nodeId,
    snapshot,
    warnings,
  } satisfies WirePreviewResponse);
}

export const POST = withWorkspaceRoute(POST_handler);
