import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { reconcileConversationLog, recoverMessagesFromLog } from '@/backend/execution/flow/conversationLog';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { getFlowRunEventBus, FlowRunFiredBy } from '@/backend/services/scheduler/flowRunEventBus';
import { EmitFn, UsageTotals } from '@/shared/types/execution/events';
import OpenAI from 'openai';
import {
  SharedState,
  TOOL_CALL_ACTION,
  FINAL_RESPONSE_ACTION,
  ERROR_ACTION,
  STAY_ON_NODE_ACTION,
  ErrorDetails,
} from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { isInternalToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { flowService } from '@/backend/services/flow/index';
import type { FlowService as FlowServiceType } from '@/backend/services/flow/index';
import { Flow } from '@/shared/types/flow';
import { loadItem as loadItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { FEATURES } from '@/config/features';
import { validateFlowForRun, validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { MAX_SUBFLOW_DEPTH } from '@/backend/execution/flow/constants';
import { isCancelledByAncestry, isConversationDeleted } from '@/backend/execution/flow/cancellation';
import { buildConversationTitle } from '@/utils/shared/conversationTitle';

const log = createLogger('backend/execution/flow/runFlow');

// --- Add getFlowByName to flowService if it doesn't exist ---
// (Moved here from chatCompletionService: flow-name resolution now lives in the
// keystone, since the OpenAI route is a thin adapter on top of runFlow.)
if (!(flowService as any).getFlowByName) {
  (flowService as any).getFlowByName = async (name: string): Promise<Flow | null> => {
    const flows = await flowService.loadFlows();
    return flows.find(flow => flow.name === name) || null;
  };
  log.info('Added getFlowByName method directly to flowService instance.');
}
const flowServiceWithGetByName = flowService as FlowServiceType & { getFlowByName: (name: string) => Promise<Flow | null> };

// Persist conversation state WITHOUT the in-memory-only debug execution trace.
const persistState = persistConversationState;

/** Cap the output carried on a runFlow-originated FlowRunEvent (issue #116). */
const MAX_EVENT_OUTPUT_CHARS = 4096;

/**
 * Announce a terminal run on the process-global FlowRunEvent bus (issue #116)
 * so `flow-event` triggers can react to chat/API/manual runs. ONLY called for
 * non-scheduled root runs (`runDepth === 0`): scheduler-fired runs are
 * announced by SchedulerService.fire() with the precise stored output + chain
 * depth, and subflow stages must never emit. Best-effort and never throws.
 */
async function publishRunFlowEvent(
  state: SharedState,
  status: 'completed' | 'error',
  outputText: string | undefined
): Promise<void> {
  try {
    const flowId = state.flowId;
    if (!flowId) {
      return;
    }
    let flowName: string | undefined;
    try {
      flowName = (await flowService.getFlow(flowId))?.name ?? undefined;
    } catch {
      /* best-effort name resolution */
    }
    // 'schedule' is filtered out before this is ever called.
    const firedBy: FlowRunFiredBy = state.source === 'api' ? 'api' : 'chat';
    const trimmed =
      outputText && outputText.length > MAX_EVENT_OUTPUT_CHARS
        ? `${outputText.slice(0, MAX_EVENT_OUTPUT_CHARS)}…`
        : outputText;
    getFlowRunEventBus().publish({
      flowId,
      flowName,
      executionId: state.plannedExecutionId,
      runId: state.conversationId || '',
      conversationId: state.conversationId || '',
      status,
      outputText: trimmed,
      firedBy,
      chainDepth: state.chainDepth ?? 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.warn('Failed to publish runFlow flow-run event:', error);
  }
}

export type FlowRunStatus = 'completed' | 'error' | 'awaiting_tool_approval' | 'paused_debug' | 'running';

/**
 * The "flow-as-callable" keystone input. One operation — run a flow with a
 * defined input → defined output, in isolated state — shared by the
 * OpenAI-compatible API (today), subflows (#13), planned executions (#10), and
 * (deferred) flows-as-MCP-tools (#17B).
 */
export interface FlowRunInput {
  /** Resolved flow id. Provide this OR `modelName`. */
  flowId?: string;
  /** OpenAI-style model string ("flow-<name>"); resolved to a flowId for a NEW
   *  conversation (mirrors the legacy completions path). Ignored when resuming
   *  an existing conversation (the flowId comes from loaded state). */
  modelName?: string;
  /** Quick-Chats (issue #61): a self-contained, in-memory flow definition to
   *  run WITHOUT persisting it to the flows store. Mutually exclusive with
   *  `flowId`/`modelName`. For a NEW conversation it is snapshotted onto the
   *  state (`flowSnapshot`) so the engine resolves it from there and follow-up
   *  turns/restarts work by construction. Ignored when resuming (the snapshot
   *  is already on the loaded state). */
  flowDefinition?: Flow;

  /** Full message list (advanced; the OpenAI route passes its request messages). */
  messages?: any[];
  /** Convenience: a single user message. Used when `messages` is absent. */
  prompt?: string;
  /** Edit support: reset execution to this node (mirrors the legacy processNodeId). */
  processNodeId?: string;
  /** Named inputs seeded onto SharedState.variables (Tier 2c) at run start.
   *  Values are coerced to string; any node can inject them via `${var:NAME}`. */
  variables?: Record<string, unknown>;

  /** 'ephemeral' runs in transient state and never writes to the conversations/*
   *  store (so the run never appears in the chat sidebar). 'conversation'
   *  (default) is the legacy persisted/resumable behavior. */
  mode?: 'ephemeral' | 'conversation';
  /** Required to resume/persist a conversation; a random id is used otherwise. */
  conversationId?: string;
  /** Sidebar title for a NEW persisted conversation (issue #156: spawn lanes
   *  are titled by their brief so parallel sub-agent runs are tellable apart).
   *  Ignored when resuming (the existing title wins) and for ephemeral runs. */
  title?: string;

  /** Engine flags (defaults preserve the legacy completions behavior). */
  flujo?: boolean;               // default true
  requireApproval?: boolean;     // default false
  debug?: boolean;               // maps to the legacy flujodebug flag; default false
  continueDebug?: boolean;       // default false
  userTurn?: boolean;            // default false

  /** Live execution events. Defaults to the per-conversation ExecutionEventBus
   *  emitter (what the OpenAI/SSE path relies on). */
  emit?: EmitFn;
  /** Conversation id of the spawning run (subflows). Recorded on the child's
   *  SharedState so cancelling an ancestor stops this run too (issue #109). */
  parentRunId?: string;
  depth?: number;

  /** Where this run originated (issue #113). Recorded on SharedState at run
   *  start and surfaced read-only by GET /api/runs/active so a suspend-when-idle
   *  orchestrator can tell scheduled runs apart from ad-hoc API/chat runs.
   *  Optional/back-compat: omitted callers report an undefined source. */
  source?: 'schedule' | 'chat' | 'api';
  /** For scheduler-originated runs: the planned execution id that fired this
   *  run (issue #113). Only meaningful when `source === 'schedule'`. */
  plannedExecutionId?: string;
  /** Event-chain depth of this run (issue #116/#117). Set by the scheduler from
   *  the firing trigger's chainDepth so a `signal` node mid-run stamps the right
   *  depth onto what it emits, and passed by SubflowNode so a child inherits the
   *  parent's depth. Organic runs (chat/API/manual) are depth 0. */
  chainDepth?: number;
  /** Headless approval policy (issue #115): what to do when a tool needs
   *  approval and this run has no interactive approver. 'auto' keeps today's
   *  behavior (run the tool); 'fail' ends the run with a structured
   *  approval-required error WITHOUT executing the tool; 'pause' persists the
   *  run as awaiting_tool_approval so it can be resumed via /api/approvals.
   *  Only consulted when `requireApproval` is true. Default 'auto'. */
  onApprovalRequired?: 'auto' | 'fail' | 'pause';
}

export interface FlowRunResult {
  status: FlowRunStatus;
  conversationId: string;
  /** Final assistant content (the default "output"), post external-tool XML wrap. */
  outputText: string;
  /** Tool calls to surface in a tool-calls response (undefined when XML-wrapped). */
  toolCalls?: OpenAI.ChatCompletionMessageToolCall[];
  /** Full transcript of THIS run. */
  messages: FlujoChatMessage[];
  /** Aggregated token/cost totals for the run. */
  usage?: UsageTotals;
  pendingToolCalls?: OpenAI.ChatCompletionMessageToolCall[];
  error?: { message: string; details?: ErrorDetails; statusCode: number };
  /** Set when flow resolution failed (the adapter maps this to a 400). */
  flowNotFound?: { name: string };
  /** The terminal action at loop exit (for finish_reason mapping by adapters). */
  finalAction?: string;
  /** Full final state. Needed by the OpenAI adapter (paused_debug returns it as
   *  debugState) and by callers that want the raw state. NOT persisted for
   *  ephemeral runs. */
  sharedState: SharedState;
}

/**
 * The keystone. Extracted (behavior-preserving) from the old
 * processChatCompletionInternal: state init + the agent loop + final persist +
 * response-content resolution. Returns a typed FlowRunResult instead of an
 * OpenAI NextResponse, so callers other than the OpenAI shim (subflows,
 * scheduler) can run flows without the HTTP/OpenAI coupling.
 */
export async function runFlow(input: FlowRunInput): Promise<FlowRunResult> {
  const startTime = Date.now();

  const flujo = input.flujo ?? true;
  const requireApproval = input.requireApproval ?? false;
  const flujodebug = input.debug ?? false;
  const continueDebug = input.continueDebug ?? false;
  const userTurn = input.userTurn ?? false;
  const ephemeral = input.mode === 'ephemeral';

  // Reconstruct the legacy `data` shape the body below reads from.
  const inputMessages: any[] = input.messages
    ?? (input.prompt !== undefined ? [{ role: 'user', content: input.prompt }] : []);
  const data: { model?: string; messages: any[]; processNodeId?: string } = {
    model: input.modelName,
    messages: inputMessages,
    processNodeId: input.processNodeId,
  };

  log.info('runFlow invoked', {
    flowId: input.flowId,
    model: input.modelName,
    messageCount: inputMessages.length,
    mode: ephemeral ? 'ephemeral' : 'conversation',
    flujo,
    requireApproval,
    flujodebug,
    conversationId: input.conversationId,
  });

  // --- 1. Initialize or Retrieve State ---
  const effectiveConvId = input.conversationId || crypto.randomUUID();
  const storageKey = `conversations/${effectiveConvId}` as StorageKey;
  let stateSource: 'storage' | 'memory' | 'new' = 'new';
  let loadedState: SharedState | undefined = undefined;
  // Issue #151: captured BEFORE the status reset below so the turn-replay guard
  // downstream can tell an error-recovery resume apart from a normal resume.
  let resumingAfterError = false;

  log.info(`Effective Conversation ID for this run: ${effectiveConvId}`, { providedId: input.conversationId });

  // Prioritize in-memory state.
  if (FlowExecutor.conversationStates.has(effectiveConvId)) {
    loadedState = FlowExecutor.conversationStates.get(effectiveConvId)!;
    log.info(`Resuming conversation ${effectiveConvId} from memory`, { currentNodeId: loadedState.currentNodeId });
    stateSource = 'memory';
  }
  // If not in memory, try storage — but never for an ephemeral run (it must stay
  // transient and never adopt a persisted conversation).
  else if (!ephemeral) {
    try {
      loadedState = await loadItemBackend<SharedState>(storageKey, undefined as any);
      if (loadedState) {
        log.info(`Loaded conversation state from storage: ${effectiveConvId}`);
        stateSource = 'storage';
        // Per-step durability lives in the append-only log; the snapshot is
        // only written at run boundaries. Fold in anything it missed (e.g. a
        // crash mid-run after messages were streamed/appended).
        await recoverMessagesFromLog(loadedState);
        FlowExecutor.conversationStates.set(effectiveConvId, loadedState);
      } else {
        log.info(`No state found in storage for conversation: ${effectiveConvId}. Will create new state.`);
      }
    } catch (error) {
      log.warn(`Error loading conversation state from storage for ${effectiveConvId}:`, error);
    }
  }

  let sharedState: SharedState;
  if (loadedState) {
    sharedState = loadedState;
    if (sharedState.conversationId !== effectiveConvId) {
      log.warn(`Loaded state's internal conversationId (${sharedState.conversationId}) differs from effectiveConvId (${effectiveConvId}). Using effectiveConvId.`);
      sharedState.conversationId = effectiveConvId;
    }

    // --- Reset status if resuming a completed/errored conversation ---
    // Also covers status === undefined: a conversation created via the create
    // route starts with NO status, and without this its whole FIRST run reports
    // undefined to the list route — so the sidebar never showed the running dot
    // / stop button for it (the SSE run:start patch was overwritten by the next
    // list poll).
    if (stateSource !== 'new' && (sharedState.status === 'completed' || sharedState.status === 'error' || sharedState.status === undefined)) {
      log.info(`Resuming completed/errored/fresh conversation ${effectiveConvId}. Resetting status to 'running'.`);
      // Issue #151: remember this was an error-recovery resume before the status
      // is cleared, so the turn-replay redirect below can act only on it.
      resumingAfterError = sharedState.status === 'error';
      sharedState.status = 'running';
      sharedState.lastResponse = undefined;
      sharedState.isCancelled = false;
      if (stateSource === 'storage') {
        FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      }
    }

    // --- Handle processNodeId if provided (for edits specifically) ---
    if (data.processNodeId && stateSource !== 'new') {
      log.info(`Edit detected: Resetting currentNodeId for conversation ${effectiveConvId} to provided processNodeId: ${data.processNodeId}`);

      sharedState.currentNodeId = data.processNodeId;
      sharedState.status = 'running';
      sharedState.lastResponse = undefined;
      sharedState.pendingToolCalls = undefined;
      sharedState.handoffRequested = undefined;
      sharedState.isCancelled = false;

      sharedState.trackingInfo = {
        executionId: crypto.randomUUID(),
        startTime: Date.now(),
        nodeExecutionTracker: [],
      };

      if (FEATURES.ENABLE_EXECUTION_TRACKER && sharedState.executionTrace) {
        sharedState.executionTrace = [];
      }

      FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      log.verbose(`State updated in memory with reset currentNodeId: ${sharedState.currentNodeId}`);
    }
  } else {
    log.info(`Creating new conversation state object for ID: ${effectiveConvId}`);
    sharedState = {
      trackingInfo: {
        executionId: crypto.randomUUID(),
        startTime: Date.now(),
        nodeExecutionTracker: FEATURES.ENABLE_EXECUTION_TRACKER ? [] : [],
      },
      messages: [],
      flowId: '',
      conversationId: effectiveConvId,
      currentNodeId: undefined,
      status: 'running',
      // A caller-supplied title (spawn lanes: the brief) sticks — the
      // first-user-message auto-titling below only replaces the placeholder.
      title: input.title?.trim() || 'New Conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugMode: flujodebug,
      executionTrace: (flujodebug && FEATURES.ENABLE_EXECUTION_TRACKER) ? [] : undefined,
      // Tier 2c: the run-scoped named-variable scratchpad starts empty and is
      // seeded from FlowRunInput.variables just below.
      variables: {},
    };
  }

  // Tier 2c (named variables): wire the dormant FlowRunInput.variables field onto
  // the state so `${var:NAME}` can inject caller-provided inputs from the first
  // node. Values are coerced to string (the scratchpad is string-only). A fresh
  // state has `variables: {}` from the literal above; a resumed state keeps its
  // persisted vars and only merges any new caller-supplied ones.
  if (input.variables && typeof input.variables === 'object') {
    sharedState.variables = sharedState.variables ?? {};
    for (const [key, value] of Object.entries(input.variables)) {
      if (value === undefined || value === null) continue;
      sharedState.variables[key] = typeof value === 'string' ? value : String(value);
    }
  }

  // The conversation's approval setting (single source of truth).
  sharedState.requireApproval = requireApproval;

  // Tag the run's origin (issue #113) so GET /api/runs/active can distinguish
  // scheduled fires from ad-hoc API/chat runs. Only overwrite when the caller
  // supplied one, so a resumed run keeps the source it was first tagged with.
  if (input.source) {
    sharedState.source = input.source;
  }
  if (input.plannedExecutionId) {
    sharedState.plannedExecutionId = input.plannedExecutionId;
  }

  // The persistence policy travels ON the state: persistConversationState (the
  // single chokepoint) refuses ephemeral states, so no path — including
  // incremental persists deep in adapters — can leak this run to the
  // conversations store. Never unset: an ephemeral run stays ephemeral.
  if (ephemeral) {
    sharedState.ephemeral = true;
  }

  // Record the spawning run's id so cancellation propagates down the run tree
  // (issue #109): the loop guard below walks this chain, and cancelling the
  // top conversation stops every descendant subflow at its next iteration.
  if (input.parentRunId) {
    sharedState.parentRunId = input.parentRunId;
  }

  // Subflow re-entrancy guard: record this run's depth and refuse to start if
  // the call tree is too deep (a flow calling itself, directly or via a chain).
  sharedState.runDepth = input.depth ?? sharedState.runDepth ?? 0;
  // Event-chain depth (issue #116/#117): threaded from the firing trigger (via
  // the scheduler) or from the parent run (via SubflowNode) so a `signal` node
  // emits at the emitting run's true depth and runaway chains trip maxChainDepth.
  sharedState.chainDepth = input.chainDepth ?? sharedState.chainDepth ?? 0;
  // Headless approval policy (#115): what to do when a tool needs approval and
  // there is no interactive approver. Persisted on the state so a resumed
  // 'pause' run keeps re-pausing (not failing) on later tool calls.
  sharedState.onApprovalRequired = input.onApprovalRequired ?? sharedState.onApprovalRequired ?? 'auto';
  if (sharedState.runDepth > MAX_SUBFLOW_DEPTH) {
    log.error(`runFlow aborted: subflow depth ${sharedState.runDepth} exceeds max ${MAX_SUBFLOW_DEPTH}`);
    sharedState.status = 'error';
    return {
      status: 'error',
      conversationId: effectiveConvId,
      outputText: '',
      messages: sharedState.messages,
      error: { message: `Subflow recursion limit (${MAX_SUBFLOW_DEPTH}) exceeded`, statusCode: 500 },
      finalAction: ERROR_ACTION,
      sharedState,
    };
  }

  // Snapshot the pre-turn messages for the log reconcile below: the incoming
  // request may REPLACE the message list (the chat client sends its full,
  // possibly pruned/edited history each turn), and the append-only log needs
  // the diff, not the replacement.
  const messagesBeforeTurn: FlujoChatMessage[] = [...(sharedState.messages ?? [])];

  // --- Configure State Based on Source ---
  if (stateSource === 'new') {
    // Quick-Chats (issue #61): an in-memory flow definition is snapshotted onto
    // the state and resolved from there by the engine — it never touches the
    // flows store. Takes precedence over flowId/modelName resolution.
    if (input.flowDefinition) {
      sharedState.flowSnapshot = input.flowDefinition;
      sharedState.flowId = input.flowDefinition.id;
    }
    // Resolve the flow: prefer an explicit flowId, else the "flow-<name>" model.
    let resolvedFlowId = input.flowDefinition ? input.flowDefinition.id : input.flowId;
    if (!resolvedFlowId && data.model) {
      const flowName = data.model.substring(5); // Assumes "flow-FlowName" format
      const reactFlow = await flowServiceWithGetByName.getFlowByName(flowName);
      if (!reactFlow) {
        log.error(`Flow not found: ${flowName}`);
        return {
          status: 'error',
          conversationId: effectiveConvId,
          outputText: '',
          messages: sharedState.messages,
          flowNotFound: { name: flowName },
          error: { message: `Flow not found: ${flowName}`, statusCode: 400 },
          finalAction: ERROR_ACTION,
          sharedState,
        };
      }
      resolvedFlowId = reactFlow.id;
    }
    if (!resolvedFlowId) {
      log.error('No flow specified for run (neither flowId nor model provided).');
      return {
        status: 'error',
        conversationId: effectiveConvId,
        outputText: '',
        messages: sharedState.messages,
        error: { message: 'No flow specified (provide flowId or model).', statusCode: 400 },
        finalAction: ERROR_ACTION,
        sharedState,
      };
    }
    sharedState.flowId = resolvedFlowId;

    // Preserve caller-provided ids/timestamps (like the resume path below).
    // The chat frontend sends its optimistic message id; keeping it means the
    // canonical copy MERGES with the optimistic bubble in the live view
    // instead of appearing as a duplicate (dedupe there is by message id).
    // depth>0 messages are display-only subflow steps served by the projection
    // — they must never (re-)enter the parent transcript / model context.
    const initialMessages: FlujoChatMessage[] = (data.messages || [])
      .filter(msg => !((msg as any).depth > 0))
      .map(msg => ({
        ...msg,
        id: (msg as any).id || crypto.randomUUID(),
        timestamp: (msg as any).timestamp || Date.now(),
        processNodeId: (msg as any).processNodeId || undefined,
      }));
    sharedState.messages = initialMessages;

    try {
      sharedState.updatedAt = Date.now();
      if (sharedState.title === 'New Conversation' && sharedState.messages.length > 0) {
        const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
        if (firstUserMessage && typeof firstUserMessage.content === 'string') {
          sharedState.title = buildConversationTitle(firstUserMessage.content);
          log.verbose(`Updated conversation title for ${effectiveConvId} during init to: ${sharedState.title}`);
        }
      }
      await persistState(storageKey, sharedState); // chokepoint refuses ephemeral states
      log.debug(`Saved initial state for new conversation ${effectiveConvId}.`);
    } catch (error) {
      log.error(`Failed to save initial state for new conversation ${effectiveConvId}:`, error);
    }
    FlowExecutor.conversationStates.set(effectiveConvId, sharedState);

  } else { // stateSource is 'storage' or 'memory'
    if (data.messages && data.messages.length > 0) {
      // As above: drop display-only subflow step messages (depth>0) so they
      // can never round-trip from the projection into the parent transcript.
      sharedState.messages = data.messages
        .filter(msg => !((msg as any).depth > 0))
        .map(msg => {
          const flujoMsg: FlujoChatMessage = {
            ...msg,
            id: (msg as any).id || crypto.randomUUID(),
            timestamp: (msg as any).timestamp || Date.now(),
            processNodeId: (msg as any).processNodeId || undefined,
          };
          return flujoMsg;
        });
      log.info(`Updated conversation ${sharedState.conversationId} with ${sharedState.messages.length} messages from request`);
    }
    if (userTurn || sharedState.debugMode === undefined) {
      sharedState.debugMode = flujodebug;
    }
    if (userTurn) {
      sharedState.debugPendingToolCalls = undefined;
    }
    if (sharedState.debugMode) {
      if (FEATURES.ENABLE_EXECUTION_TRACKER && !sharedState.executionTrace) {
        sharedState.executionTrace = [];
      }
    }
  }

  // --- Bring the append-only conversation log in line with this turn's input ---
  // Bootstraps the log for brand-new/legacy conversations and records the diff
  // (new turns, edits, pruned messages) for logged ones, BEFORE any run event
  // is emitted. Ephemeral runs are refused inside. Advisory on failure: the
  // legacy SharedState persistence below still covers the conversation.
  try {
    await reconcileConversationLog(sharedState, messagesBeforeTurn);
  } catch (error) {
    log.warn(`Conversation-log reconcile failed for ${effectiveConvId}; continuing`, error);
  }

  // --- Direct a new user turn to its intended node (one-time, at turn start) ---
  if (userTurn && stateSource !== 'new' && !data.processNodeId) {
    const lastMsg = sharedState.messages.length > 0
      ? sharedState.messages[sharedState.messages.length - 1]
      : undefined;
    if (lastMsg?.role === 'user' && lastMsg.processNodeId && lastMsg.processNodeId !== sharedState.currentNodeId) {
      log.info(`New user turn for ${effectiveConvId}: directing execution to node ${lastMsg.processNodeId} (was ${sharedState.currentNodeId}).`);
      sharedState.currentNodeId = lastMsg.processNodeId;
      FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
    }
  }

  // --- Replay an errored turn from its entry node (issue #151) ---
  // The Retry button re-sends the existing history with NO new user message, so
  // the redirect above (which only fires for a fresh trailing user turn) leaves
  // execution parked at the errored mid-flow node. Resuming directly there when
  // that node uses `latest-message`/`isolated` narrows the wire to just the
  // current turn's tail and drops all prior conversation — the reported context
  // loss. Instead, when resuming an ERRORED conversation with no fresh user turn
  // and no explicit edit target, re-enter at the turn's ENTRY node (the
  // processNodeId of the last user message) so a full-history entry node rebuilds
  // context before routing forward. Falls back to the flow's start node when that
  // message is unstamped. Persisted conversations only (never ephemeral runs).
  if (resumingAfterError && userTurn && !ephemeral && stateSource !== 'new' && !data.processNodeId) {
    const lastMsg = sharedState.messages.length > 0
      ? sharedState.messages[sharedState.messages.length - 1]
      : undefined;
    // A fresh trailing user turn is already handled by the redirect above; only
    // act on a Retry (history ends on an assistant/tool message).
    if (lastMsg?.role !== 'user') {
      let entryNodeId: string | undefined;
      for (let i = sharedState.messages.length - 1; i >= 0; i--) {
        if (sharedState.messages[i].role === 'user') {
          entryNodeId = sharedState.messages[i].processNodeId;
          break;
        }
      }
      if (!entryNodeId && sharedState.flowId) {
        try {
          const flow = await flowService.getFlow(sharedState.flowId);
          entryNodeId = flow?.nodes?.find((n) => n.type === 'start')?.id;
        } catch (err) {
          log.warn(`Could not resolve start node for error-resume of ${effectiveConvId}`, err);
        }
      }
      if (entryNodeId && entryNodeId !== sharedState.currentNodeId) {
        log.info(`Error-resume for ${effectiveConvId}: replaying turn from entry node ${entryNodeId} (was ${sharedState.currentNodeId}).`);
        sharedState.currentNodeId = entryNodeId;
        FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      }
    }
  }

  // --- Force a fresh compiled flow at the start of each user turn ---
  if (userTurn && sharedState.flowId) {
    FlowExecutor.clearFlowCache(sharedState.flowId);
    log.debug(`Cleared compiled-flow cache for ${sharedState.flowId} at start of user turn ${effectiveConvId}.`);
  }

  // --- 2. Main Execution Logic ---
  let currentAction: string | undefined = undefined;
  // Set when the pre-run consistency check below fails. The execution loop is
  // skipped and the standard terminal/error path reports it.
  let preflightError = false;
  const MAX_INTERNAL_ITERATIONS = 150;
  let internalIterations = 0;

  // --- Execution event emission (live progress + debugger) ---
  const emit: EmitFn = input.emit ?? executionEventBus.emitterFor(effectiveConvId);
  // Emission is tracked by message IDENTITY, not index: ProcessNode.post
  // REPLACES sharedState.messages with a system-message-prefixed copy of the
  // node context, so an index cursor shifts and re-emits the last pre-step
  // message (the user's turn — seen as a duplicated bubble in the live view).
  // Everything present at run start counts as already known to the client
  // (it fetches full state on connect / shows the user message optimistically).
  const emittedMessageIds = new Set<string>(
    sharedState.messages.map(m => m.id).filter((id): id is string => !!id)
  );

  const accumulateUsage = (msg: FlujoChatMessage) => {
    if (!msg.usage) return;
    const totals: UsageTotals = sharedState.usage ?? {
      promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, byNode: {},
    };
    totals.promptTokens += msg.usage.promptTokens;
    totals.completionTokens += msg.usage.completionTokens;
    totals.totalTokens += msg.usage.totalTokens;
    // Cache RE-READ tokens are a subset of promptTokens; track them separately so
    // the UI can show the honest "fresh (+cached)" split (#87). Guard with ?? 0
    // so state persisted before #87 (no cacheReadTokens) doesn't produce NaN.
    const msgCacheRead = msg.usage.cacheReadTokens ?? 0;
    if (msgCacheRead) totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + msgCacheRead;
    const nodeKey = msg.processNodeId || 'unknown';
    const node = totals.byNode[nodeKey] ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
    node.promptTokens += msg.usage.promptTokens;
    node.completionTokens += msg.usage.completionTokens;
    node.totalTokens += msg.usage.totalTokens;
    if (msgCacheRead) node.cacheReadTokens = (node.cacheReadTokens ?? 0) + msgCacheRead;
    totals.byNode[nodeKey] = node;
    sharedState.usage = totals;
    emit({
      type: 'usage',
      node: msg.processNodeId ? { nodeId: msg.processNodeId } : undefined,
      promptTokens: msg.usage.promptTokens,
      completionTokens: msg.usage.completionTokens,
      totalTokens: msg.usage.totalTokens,
      costUsd: 0,
      ...(msgCacheRead ? { cacheReadTokens: msgCacheRead } : {}),
    });
  };

  const emitNewMessages = () => {
    for (const msg of sharedState.messages) {
      // Strengthen the id invariant at the emission boundary: a message
      // without an id could never be tracked (or deduped by any consumer).
      if (!msg.id) msg.id = crypto.randomUUID();
      if (emittedMessageIds.has(msg.id)) continue;
      emittedMessageIds.add(msg.id);
      // The node's system prompt (prepended into the transcript by
      // ProcessNode.post's write-back) is model plumbing, not conversation
      // content — never emitted under the old index cursor either (it lands
      // BEFORE the cursor). Keep it out of the live stream.
      if (msg.role === 'system') continue;
      emit({
        type: 'message',
        message: msg,
        node: msg.processNodeId ? { nodeId: msg.processNodeId } : undefined,
      });
      accumulateUsage(msg);
    }
  };

  emit({ type: 'run:start', flowId: sharedState.flowId });

  // --- Pre-run consistency check (blocking) ---
  // Only at the start of a run: a genuine new user turn or a brand-new
  // conversation (which covers subflow child runs — this lives in the keystone
  // so EVERY caller gets it, not just the OpenAI route). Internal resumes
  // (debug step/continue, tool-approval respond) continue an already-started
  // run and must not be re-blocked. If the flow has error-level issues
  // (deleted model, renamed/deleted MCP server, missing Start node, dangling
  // tool references, …), abort before any node runs. The standard terminal/
  // error path below formats the result (and emits run:done).
  if ((userTurn || stateSource === 'new') && sharedState.flowId) {
    try {
      // Quick-Chat snapshots aren't in the store, so validate the in-memory
      // object; everything else validates by id (unchanged path).
      const validation = sharedState.flowSnapshot
        ? await validateFlowObjectForRun(sharedState.flowSnapshot)
        : await validateFlowForRun(sharedState.flowId);
      if (!validation.isRunnable) {
        const errs = validation.issues.filter(i => i.severity === 'error');
        const message =
          `This flow can't run yet — please fix the following before running:\n` +
          errs.map(e => `• ${e.message}`).join('\n');
        log.warn(`Pre-run validation blocked flow ${sharedState.flowId} for conv ${effectiveConvId}`, {
          errorCount: errs.length,
          codes: errs.map(e => e.code),
        });
        sharedState.lastResponse = {
          success: false,
          error: message,
          errorDetails: { message, type: 'invalid_request_error', code: 'flow_invalid', status: 400 },
        };
        currentAction = ERROR_ACTION;
        preflightError = true;
      }
    } catch (validationError) {
      // A failure to RUN the check must not block the user — log and proceed.
      log.warn(`Pre-run validation could not complete for ${sharedState.flowId}; proceeding`, validationError);
    }
  }

  // Cancellation covers this run's own flag AND any ancestor's (issue #109): a
  // subflow child has its own SharedState, so the parent's flag only reaches it
  // through the parentRunId chain. Once an ancestor is found cancelled, the flag
  // is copied onto this state so descendants (and later checks) short-circuit.
  const runCancelled = (): boolean => {
    if (sharedState.isCancelled) return true;
    if (isCancelledByAncestry(sharedState.parentRunId, FlowExecutor.conversationStates)) {
      sharedState.isCancelled = true;
      return true;
    }
    return false;
  };

  const singleStep = !!sharedState.debugMode && !continueDebug;
  const pauseForDebug = () => {
    sharedState.status = 'paused_debug';
    emit({ type: 'run:paused', reason: 'debug', node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined });
  };

  try {
    if (!preflightError) {
      while (true) {
        internalIterations++;
        log.debug(`--- Starting Execution Step ${internalIterations} for Conv ${effectiveConvId} ---`);

        if (internalIterations > MAX_INTERNAL_ITERATIONS) {
          log.warn(`Max internal iterations (${MAX_INTERNAL_ITERATIONS}) reached for conv ${effectiveConvId}. Breaking loop.`);
          if (currentAction !== ERROR_ACTION) {
            sharedState.lastResponse = { success: false, error: `Maximum internal iterations (${MAX_INTERNAL_ITERATIONS}) reached.` };
            currentAction = ERROR_ACTION;
          }
          break;
        }

        if (runCancelled()) {
          log.info(`Cancellation flag detected for conv ${effectiveConvId}. Terminating execution.`);
          sharedState.status = 'error';
          sharedState.lastResponse = { success: false, error: 'Execution cancelled by user.' };
          currentAction = ERROR_ACTION;
          break;
        }

        // Debug step granularity: execute tool calls a previous step paused before.
        if (sharedState.debugPendingToolCalls && sharedState.debugPendingToolCalls.length > 0) {
          const pendingCalls = sharedState.debugPendingToolCalls;
          sharedState.debugPendingToolCalls = undefined;
          log.info(`[Debug Step] Executing ${pendingCalls.length} pending tool call(s) for conv ${effectiveConvId}.`);
          const toolProcessingResult = await ModelHandler.processToolCalls({
            toolCalls: pendingCalls, toolNameMap: sharedState.toolNameMap, emit,
            // Run-resource auto-capture: ephemeral (subflow-child) runs never
            // write resources — same policy as persistConversationState.
            conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
            node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
            shouldAbort: runCancelled,
          });
          if (!toolProcessingResult.success) {
            log.error(`Debug tool processing failed for conv ${effectiveConvId}`, { error: toolProcessingResult.error });
            sharedState.lastResponse = { success: false, error: 'Tool processing failed', errorDetails: toolProcessingResult.error };
            currentAction = ERROR_ACTION;
            break;
          }
          const toolResultMessages: FlujoChatMessage[] = toolProcessingResult.value.toolCallMessages.map(msg => ({
            ...msg,
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            processNodeId: sharedState.currentNodeId,
          }));
          sharedState.messages.push(...toolResultMessages);
          FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
          emitNewMessages();
          try {
            sharedState.updatedAt = Date.now();
            await persistState(storageKey, sharedState); // chokepoint refuses ephemeral states
          } catch (error) {
            log.error(`Failed to save state after debug tool execution for conv ${effectiveConvId}:`, error);
          }
          if (singleStep) {
            log.info(`[Debug Step] Paused after tool execution for conv ${effectiveConvId}.`);
            pauseForDebug();
            break;
          }
          continue;
        }

        // Breakpoint check.
        if (!singleStep && sharedState.breakpoints && sharedState.breakpoints.length > 0) {
          const nextNodeId = await FlowExecutor.peekNextNodeId(sharedState);
          if (nextNodeId && sharedState.breakpoints.includes(nextNodeId) && sharedState.lastBreakNodeId !== nextNodeId) {
            log.info(`Breakpoint hit at node ${nextNodeId} for conv ${effectiveConvId}. Pausing.`);
            sharedState.status = 'paused_debug';
            sharedState.debugMode = true;
            sharedState.lastBreakNodeId = nextNodeId;
            emit({ type: 'breakpoint:hit', node: { nodeId: nextNodeId } });
            emit({ type: 'run:paused', reason: 'breakpoint', node: { nodeId: nextNodeId } });
            try {
              sharedState.updatedAt = Date.now();
              await persistState(storageKey, sharedState); // chokepoint refuses ephemeral states
            } catch (error) {
              log.error(`Failed to save state on breakpoint for conv ${effectiveConvId}:`, error);
            }
            break;
          } else if (nextNodeId && sharedState.lastBreakNodeId && nextNodeId !== sharedState.lastBreakNodeId) {
            sharedState.lastBreakNodeId = undefined;
          }
        }

        if (sharedState.messages.length > 0) {
          const lastFewMessages = sharedState.messages.slice(-3);
          log.verbose(`Message history before step ${internalIterations}`, lastFewMessages);
        } else {
          log.verbose(`No messages in history before step ${internalIterations}`);
        }

        // 2a. Execute one step of the flow
        const stepResult = await FlowExecutor.executeStep(sharedState, emit);
        sharedState = stepResult.sharedState;
        currentAction = stepResult.action;
        emitNewMessages();

        // No mid-loop state snapshot: per-step durability is the append-only
        // conversation log (every emitted event is appended by the bus tap;
        // this replaced the old rewrite-the-whole-file-per-step and its 500ms
        // throttle). The full SharedState snapshot is written only at run
        // boundaries — initial save, every pause, breakpoints, the final save —
        // and a storage load folds log messages the snapshot missed back in
        // (recoverMessagesFromLog).
        sharedState.updatedAt = Date.now();
        if (sharedState.title === 'New Conversation' && sharedState.messages.length > 0) {
          const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
          if (firstUserMessage && typeof firstUserMessage.content === 'string') {
            sharedState.title = buildConversationTitle(firstUserMessage.content);
            log.verbose(`Updated conversation title for ${effectiveConvId} after step ${internalIterations} to: ${sharedState.title}`);
          }
        }

        log.info(`Step ${internalIterations} completed for conv ${effectiveConvId}. Action: ${currentAction}`, { currentNodeId: sharedState.currentNodeId });
        log.verbose(`Shared state after step ${internalIterations}`, sharedState);

        log.debug(`[Action Handling] Step ${internalIterations}: Received action "${currentAction}" for conv ${effectiveConvId}`);

        // 2b. Handle the action returned by the step
        if (currentAction === ERROR_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling ERROR_ACTION for conv ${effectiveConvId}`);
          log.error(`Error action received during step ${internalIterations} for conv ${effectiveConvId}`, { error: sharedState.lastResponse });
          break;
        }

        if (currentAction === FINAL_RESPONSE_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling FINAL_RESPONSE_ACTION for conv ${effectiveConvId}`);
          log.info(`Final response action received at step ${internalIterations} for conv ${effectiveConvId}`);
          sharedState.status = 'completed';
          log.info(`Setting conversation status to 'completed' for conv ${effectiveConvId}`);
          break;
        }

        if (currentAction === TOOL_CALL_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling TOOL_CALL_ACTION for conv ${effectiveConvId}`);
          log.info(`Tool call action received at step ${internalIterations} for conv ${effectiveConvId}`);
          const lastAssistantMsg = sharedState.messages.length > 0 ? sharedState.messages[sharedState.messages.length - 1] : null;

          if (lastAssistantMsg?.role === 'assistant' && lastAssistantMsg.tool_calls) {
            if (flujo) {
              // --- Flujo=true: Handle optional approval ---
              if (requireApproval && sharedState.onApprovalRequired === 'fail') {
                // Headless fail-fast (#115): a tool needs approval but this run
                // has no interactive approver. Do NOT execute the tool and do
                // NOT hang — end the run with a structured approval-required
                // error so the scheduler can record a `needs_approval` outcome.
                const firstCall = lastAssistantMsg.tool_calls[0];
                const toolName =
                  firstCall && firstCall.type === 'function' ? firstCall.function.name : 'unknown';
                log.info(`[flujo=true, onApprovalRequired=fail] Failing fast for tool "${toolName}" (conv ${effectiveConvId})`);
                sharedState.status = 'error';
                sharedState.pendingToolCalls = lastAssistantMsg.tool_calls;
                sharedState.lastResponse = {
                  success: false,
                  error: `Headless run requires approval for tool "${toolName}" but no approver is available (approvalPolicy: fail).`,
                  errorDetails: {
                    message: `Headless run requires approval for tool "${toolName}" but no approver is available (approvalPolicy: fail).`,
                    type: 'approval_required',
                    name: toolName,
                  },
                };
                currentAction = ERROR_ACTION;
                break;
              }
              if (requireApproval) {
                log.info(`[flujo=true, requireApproval=true] Pausing execution for tool approval for conv ${effectiveConvId}`);
                sharedState.status = 'awaiting_tool_approval';
                sharedState.pendingToolCalls = lastAssistantMsg.tool_calls;
                sharedState.lastResponse = undefined;
                FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                try {
                  sharedState.updatedAt = Date.now();
                  if (sharedState.title === 'New Conversation' && sharedState.messages.length > 0) {
                    const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
                    if (firstUserMessage && typeof firstUserMessage.content === 'string') {
                      sharedState.title = buildConversationTitle(firstUserMessage.content);
                      log.verbose(`Updated conversation title for ${effectiveConvId} before pausing to: ${sharedState.title}`);
                    }
                  }
                  await persistState(storageKey, sharedState); // chokepoint refuses ephemeral states
                  log.verbose(`Saved state before pausing for approval for conv ${effectiveConvId}`);
                } catch (error) {
                  log.error(`Failed to save state before pausing for approval for conv ${effectiveConvId}:`, error);
                }
                emit({ type: 'run:awaiting_approval', pendingToolCalls: lastAssistantMsg.tool_calls });
                break;
              } else if (singleStep) {
                log.info(`[Debug Step] Paused before executing ${lastAssistantMsg.tool_calls.length} tool call(s) for conv ${effectiveConvId}.`);
                sharedState.debugPendingToolCalls = lastAssistantMsg.tool_calls;
                FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                try {
                  sharedState.updatedAt = Date.now();
                  await persistState(storageKey, sharedState); // chokepoint refuses ephemeral states
                } catch (error) {
                  log.error(`Failed to save state before debug tool pause for conv ${effectiveConvId}:`, error);
                }
                pauseForDebug();
                break;
              } else {
                log.info(`[flujo=true, requireApproval=false] Processing ${lastAssistantMsg.tool_calls.length} tools internally for conv ${effectiveConvId}`);
                const toolProcessingResult = await ModelHandler.processToolCalls({
                  toolCalls: lastAssistantMsg.tool_calls, toolNameMap: sharedState.toolNameMap, emit,
                  conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
                  node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
                  shouldAbort: runCancelled,
                });

                if (!toolProcessingResult.success) {
                  log.error(`Internal tool processing failed for conv ${effectiveConvId}`, { error: toolProcessingResult.error });
                  sharedState.lastResponse = { success: false, error: 'Tool processing failed', errorDetails: toolProcessingResult.error };
                  currentAction = ERROR_ACTION;
                  break;
                }

                log.info(`Adding ${toolProcessingResult.value.toolCallMessages.length} tool result messages for conv ${effectiveConvId}`);
                const toolResultMessagesWithTimestamp: FlujoChatMessage[] = toolProcessingResult.value.toolCallMessages.map(msg => ({
                  ...msg,
                  id: crypto.randomUUID(),
                  timestamp: Date.now(),
                  processNodeId: sharedState.currentNodeId,
                }));
                sharedState.messages.push(...toolResultMessagesWithTimestamp);
                FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                emitNewMessages();
                log.info(`Continuing loop for conv ${effectiveConvId} after internal tool processing (no approval needed).`);
                continue;
              }
            } else {
              // --- flujo=false: Handle internal vs external tools ---
              log.info(`[flujo=false] Tool call action received for conv ${effectiveConvId}. Checking tool types.`);
              const allToolCalls = lastAssistantMsg.tool_calls || [];
              const internalTools: OpenAI.ChatCompletionMessageToolCall[] = [];
              const externalTools: OpenAI.ChatCompletionMessageToolCall[] = [];

              allToolCalls.forEach(tc => {
                if (tc.type === 'function' && isInternalToolName(tc.function.name, sharedState.toolNameMap)) {
                  log.verbose('tool is internal:', tc.function.name);
                  internalTools.push(tc);
                } else {
                  log.verbose('tool is external:', tc.function.name);
                  externalTools.push(tc);
                }
              });

              if (internalTools.length > 0) {
                log.info(`[flujo=false] Processing ${internalTools.length} internal tools for conv ${effectiveConvId}. External tools (${externalTools.length}) will be ignored this step.`);
                const toolProcessingResult = await ModelHandler.processToolCalls({
                  toolCalls: internalTools, toolNameMap: sharedState.toolNameMap, emit,
                  conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
                  node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
                  shouldAbort: runCancelled,
                });

                if (!toolProcessingResult.success) {
                  log.error(`[flujo=false] Internal tool processing failed for conv ${effectiveConvId}`, { error: toolProcessingResult.error });
                  sharedState.lastResponse = { success: false, error: 'Internal tool processing failed', errorDetails: toolProcessingResult.error };
                  currentAction = ERROR_ACTION;
                  break;
                }

                log.info(`Adding ${toolProcessingResult.value.toolCallMessages.length} internal tool result messages for conv ${effectiveConvId}`);
                const internalToolResultMessagesWithTimestamp: FlujoChatMessage[] = toolProcessingResult.value.toolCallMessages.map(msg => ({
                  ...msg,
                  id: crypto.randomUUID(),
                  timestamp: Date.now(),
                  processNodeId: sharedState.currentNodeId,
                }));
                sharedState.messages.push(...internalToolResultMessagesWithTimestamp);
                FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                log.info(`Continuing loop for conv ${effectiveConvId} after internal tool processing (flujo=false).`);
                continue;

              } else if (externalTools.length > 0) {
                log.info(`[flujo=false] Found ${externalTools.length} external tools for conv ${effectiveConvId}. Wrapping in XML and returning.`);

                const xmlToolStrings: string[] = [];
                for (const toolCall of externalTools) {
                  if (toolCall.type === 'function') {
                    try {
                      const args = JSON.parse(toolCall.function.arguments || '{}');
                      let paramsXml = '';
                      for (const key in args) {
                        const value = String(args[key]).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');                      paramsXml += `\n<${key}>${value}</${key}>`;
                      }
                      xmlToolStrings.push(`<${toolCall.function.name}>${paramsXml}\n</${toolCall.function.name}>`);
                    } catch (parseError) {
                      log.error(`[flujo=false] Failed to parse arguments for external tool ${toolCall.function.name}`, { args: toolCall.function.arguments, error: parseError, convId: effectiveConvId });
                      xmlToolStrings.push(`<${toolCall.function.name}>\n<error>Failed to parse arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}</error>\n</${toolCall.function.name}>`);
                    }
                  }
                }

                sharedState.lastResponse = {
                  _flujo_xml_tools: xmlToolStrings.join('\n\n'),
                };

                currentAction = FINAL_RESPONSE_ACTION;
                log.info(`[flujo=false] Prepared XML for external tools. Exiting loop for conv ${effectiveConvId}.`);
                break;

              } else {
                log.warn(`[flujo=false] TOOL_CALL_ACTION received for conv ${effectiveConvId} but no tools found after classification. Treating as final.`);
                currentAction = FINAL_RESPONSE_ACTION;
                break;
              }
            }
          } else {
            log.warn(`TOOL_CALL_ACTION received for conv ${effectiveConvId} but no tool_calls found in last message. Treating as final.`);
            currentAction = FINAL_RESPONSE_ACTION;
            break;
          }
        }

        // Check if action is an edgeId (Handoff).
        const handoff = await FlowExecutor.resolveHandoff(sharedState, currentAction);

        if (handoff.isSuccessorEdge) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling Handoff Action (Edge ID) for conv ${effectiveConvId}`);
          log.info(`Handoff action received for conv ${effectiveConvId}. Edge: ${currentAction}`);
          const nextNodeId = handoff.targetNodeId;
          if (typeof nextNodeId === 'string' && nextNodeId.length > 0) {

            const lastAssistantMsg = sharedState.messages.length > 0 ? sharedState.messages[sharedState.messages.length - 1] : null;

            if (lastAssistantMsg?.role === 'assistant' && lastAssistantMsg.tool_calls) {
              const allHandoffCalls = lastAssistantMsg.tool_calls.filter(tc =>
                tc.type === 'function' &&
                (tc.function.name === 'handoff' || tc.function.name.startsWith('handoff_to_'))
              );
              // Spawn-with-brief (issue #156): the routing model may call the SAME
              // handoff tool several times in one turn — each call is one spawned
              // lane of the target sub-agent, briefed by its `task` argument. So
              // the capture walks EVERY handoff call that resolves to the chosen
              // target (via handoffNameMap; legacy names embed the node id), not
              // just the first one, and answers each with its own tool result so
              // the transcript stays well-formed (one result per tool_call id).
              const resolveCallTarget = (name: string): string =>
                sharedState.handoffNameMap?.[name] || name.replace('handoff_to_', '');
              const matchingCalls = allHandoffCalls.filter(
                tc => tc.type === 'function' && resolveCallTarget(tc.function.name) === nextNodeId
              );
              // Defensive: an edge chosen without a decodable matching call (e.g.
              // a deterministic-condition route after a tool-call turn) keeps the
              // legacy "first handoff call" pairing so its result never dangles.
              const callsToAnswer = matchingCalls.length > 0 ? matchingCalls : allHandoffCalls.slice(0, 1);

              if (callsToAnswer.length === 0) {
                log.warn(`Handoff action received for edge ${currentAction}, but could not find corresponding handoff tool call in last assistant message.`);
              }

              // Capture caller-supplied handoff input: `prompt` (issue #96,
              // single-call caller prompt), `task` briefs (issue #156 spawns —
              // one per call), and the legacy `parallelFlows`/`concurrencyLimit`
              // (issue #130; no tool exposes them anymore but a resumed old
              // conversation may still send them). Single-shot and node-id-scoped;
              // the target node's prep consumes and clears it. A malformed args
              // string must NEVER break routing — parse defensively per call.
              const briefs: string[] = [];
              let callerPrompt = '';
              let callerFlows: string[] | undefined;
              let callerConcurrency: number | undefined;
              callsToAnswer.forEach((call, laneIdx) => {
                if (call.type === 'function') {
                  try {
                    const parsedArgs = JSON.parse(call.function.arguments || '{}');
                    const task = typeof parsedArgs?.task === 'string' ? parsedArgs.task.trim() : '';
                    const prompt = typeof parsedArgs?.prompt === 'string' ? parsedArgs.prompt.trim() : '';
                    // `task` is always a spawn brief; a `prompt` on a MULTI-call
                    // turn clearly means per-instance instructions too. On a
                    // single-call turn `prompt` keeps its issue-#96 meaning.
                    const brief = task || (callsToAnswer.length > 1 ? prompt : '');
                    if (brief) briefs.push(brief);
                    if (!callerPrompt && prompt) callerPrompt = prompt;
                    if (!callerFlows && Array.isArray(parsedArgs?.parallelFlows)) {
                      const flows = parsedArgs.parallelFlows.filter(
                        (f: unknown): f is string => typeof f === 'string' && f.trim() !== '',
                      );
                      if (flows.length > 0) callerFlows = flows;
                    }
                    const rawLimit = parsedArgs?.concurrencyLimit;
                    if (callerConcurrency === undefined && typeof rawLimit === 'number' && rawLimit >= 1) {
                      callerConcurrency = Math.floor(rawLimit);
                    }
                  } catch (parseError) {
                    log.warn(`Could not parse handoff tool-call arguments for edge ${currentAction}; ignoring caller input for this call`, { parseError });
                  }
                }
                sharedState.messages.push({
                  id: crypto.randomUUID(),
                  role: 'tool',
                  tool_call_id: call.id,
                  content: JSON.stringify({
                    status: 'Handoff processed',
                    targetNodeId: nextNodeId,
                    ...(callsToAnswer.length > 1 ? { lane: laneIdx + 1, laneCount: callsToAnswer.length } : {}),
                  }),
                  timestamp: Date.now(),
                  processNodeId: sharedState.currentNodeId,
                });
              });
              // Handoff calls that targeted a DIFFERENT node lost the route (one
              // successor wins per turn). Answer them too — a tool_call id
              // without a result corrupts the persisted transcript — with an
              // explicit not-executed status. (All handoff plumbing is stripped
              // from the model wire either way.)
              for (const call of allHandoffCalls) {
                if (callsToAnswer.includes(call)) continue;
                sharedState.messages.push({
                  id: crypto.randomUUID(),
                  role: 'tool',
                  tool_call_id: call.id,
                  content: JSON.stringify({ status: 'Not executed', reason: 'A different handoff was chosen this turn.' }),
                  timestamp: Date.now(),
                  processNodeId: sharedState.currentNodeId,
                });
                log.warn(`Handoff call ${call.type === 'function' ? call.function.name : call.id} targeted a different node than the chosen route; answered as not executed.`);
              }
              // A lone brief also serves as the caller prompt so a single
              // `task`-style call still drives an isolated allowCallerPrompt
              // subflow that never opted into spawning.
              if (!callerPrompt && briefs.length === 1) callerPrompt = briefs[0];
              if (callerPrompt || briefs.length > 0 || (callerFlows && callerFlows.length > 0)) {
                sharedState.handoffInput = {
                  targetNodeId: nextNodeId,
                  prompt: callerPrompt,
                  ...(briefs.length > 0 ? { tasks: briefs } : {}),
                  ...(callerFlows && callerFlows.length > 0 ? { parallelFlows: callerFlows } : {}),
                  ...(callerConcurrency !== undefined ? { concurrencyLimit: callerConcurrency } : {}),
                };
                log.info(`Captured caller handoff input for node ${nextNodeId}`, {
                  promptChars: callerPrompt.length,
                  spawnBriefs: briefs.length,
                  fanoutCount: callerFlows?.length ?? 0,
                });
              } else {
                // Issue #169 belt-and-suspenders: a handoff to an isolated,
                // non-fanout, allowCallerPrompt subflow that has NO authored
                // promptTemplate WITHOUT a caller-supplied prompt (a provider
                // ignored the schema `required` we now emit in
                // ProcessNode.generateHandoffTools) would start the subflow with
                // an empty prompt and stall silently. Surface a clear, actionable
                // warning instead of proceeding quietly.
                try {
                  const handoffFlow = await flowService.getFlow(sharedState.flowId);
                  const targetNode = handoffFlow?.nodes?.find(n => n.id === nextNodeId);
                  const targetProps = targetNode?.data?.properties as { inputMode?: string; allowCallerPrompt?: boolean; allowCallerFanout?: boolean; promptTemplate?: string } | undefined;
                  if (
                    targetNode?.type === 'subflow' &&
                    targetProps?.inputMode === 'isolated' &&
                    targetProps?.allowCallerPrompt === true &&
                    targetProps?.allowCallerFanout !== true &&
                    !(targetProps?.promptTemplate?.trim())
                  ) {
                    log.warn(
                      `Handoff to isolated subflow node ${nextNodeId} has neither a caller-supplied prompt nor an authored promptTemplate; the subflow will start with an empty prompt and may stall. The routing model should have supplied the required "prompt" argument (issue #169).`,
                      { targetNodeId: nextNodeId },
                    );
                  }
                } catch (guardErr) {
                  log.debug('Issue #169 empty-prompt handoff guard check failed (non-fatal)', { guardErr });
                }
              }

              // NOTE: we no longer append a synthetic "The handoff was
              // successful. Continue" user message. The receiving node now
              // builds its model context via buildNodeContext('scoped'), which
              // strips this handoff tool-call/result so the model sees a clean
              // conversation ending on the real task and responds naturally.
              // See ~/.claude/plans/execution-core-v2.md.
            } else {
              log.warn(`Handoff action received for edge ${currentAction}, but the last message was not an assistant message with tool calls.`);
            }

            emitNewMessages();
            const fromNodeId = sharedState.currentNodeId;
            sharedState.currentNodeId = nextNodeId;
            sharedState.handoffRequested = undefined;
            emit({
              type: 'handoff',
              from: fromNodeId ? { nodeId: fromNodeId } : undefined,
              toNodeId: nextNodeId,
              edgeId: currentAction,
            });
            log.info(`Transitioning conv ${effectiveConvId} to node ${sharedState.currentNodeId}`);
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            if (singleStep) {
              log.info(`[Debug Step] Paused after handoff to node ${sharedState.currentNodeId} for conv ${effectiveConvId}.`);
              pauseForDebug();
              break;
            }
            log.info(`Continuing loop for conv ${effectiveConvId} after handoff.`);
            continue;
          } else {
            log.error(`Handoff failed for conv ${effectiveConvId}: Successor node for edge ${currentAction} has invalid ID.`);
            sharedState.lastResponse = { success: false, error: `Handoff failed: Target node for edge ${currentAction} has invalid ID.` };
            currentAction = ERROR_ACTION;
            break;
          }
        }

        if (currentAction === STAY_ON_NODE_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling STAY_ON_NODE_ACTION for conv ${effectiveConvId}`);
          log.info(`Stay on node action received for conv ${effectiveConvId} at step ${internalIterations}`);
          break;
        }

        log.warn(`Unrecognized action '${currentAction}' received at step ${internalIterations} for conv ${effectiveConvId}. Treating as final response.`);
        currentAction = FINAL_RESPONSE_ACTION;
        break;

      } // --- End while loop ---
    } // --- End execution block ---

  } catch (loopError) {
    log.error(`Unhandled error during execution loop for conv ${effectiveConvId}`, { loopError });
    if (currentAction !== ERROR_ACTION && runCancelled()) {
      // A cancellation can surface as a thrown error (the model-call watch
      // aborts the in-flight provider request, which throws out of the step).
      // Report it as the standard cancellation outcome, not a provider failure.
      sharedState.status = 'error';
      sharedState.lastResponse = { success: false, error: 'Execution cancelled by user.' };
      currentAction = ERROR_ACTION;
    }
    if (currentAction !== ERROR_ACTION) {
      const modelDetails = (loopError as any)?.details;
      sharedState.lastResponse = {
        success: false,
        error: loopError instanceof Error ? loopError.message : String(loopError),
        errorDetails: loopError instanceof Error
          ? {
              name: loopError.name,
              message: loopError.message,
              stack: loopError.stack,
              ...(modelDetails && typeof modelDetails === 'object' ? modelDetails : {}),
            }
          : undefined,
      };
      currentAction = ERROR_ACTION;
    }
  }

  // A cancellation that lands while the final step is completing (or one the
  // provider ignored) must not let the run report 'completed' — Stop means
  // stop, even when the model's answer won the race.
  if (currentAction !== ERROR_ACTION && runCancelled()) {
    log.info(`Cancellation flag set at run end for conv ${effectiveConvId}; reporting cancelled instead of '${sharedState.status}'.`);
    sharedState.status = 'error';
    sharedState.lastResponse = { success: false, error: 'Execution cancelled by user.' };
    currentAction = ERROR_ACTION;
  }

  // Reconcile status with the terminal action BEFORE the final persist.
  if (currentAction === ERROR_ACTION && sharedState.status !== 'error') {
    sharedState.status = 'error';
  }

  // --- 3. Finalize ---
  const finalExecutionTime = Date.now() - startTime;
  const finalStatus = sharedState.status || (currentAction === FINAL_RESPONSE_ACTION ? 'completed' : (currentAction === ERROR_ACTION ? 'error' : 'running'));
  log.info(`Execution finished for conv ${effectiveConvId}. Final Action: ${currentAction}, Final Status: ${finalStatus}`, { duration: `${finalExecutionTime}ms` });

  // Flush any trailing messages and signal terminal completion to live consumers.
  emitNewMessages();
  if (finalStatus === 'completed' || finalStatus === 'error') {
    emit({ type: 'run:done', status: finalStatus });
    // Flow-run event bus (issue #116): announce terminal runs so `flow-event`
    // triggers can react to chat/API/manual runs. Scheduler-fired runs are
    // announced by SchedulerService.fire() instead (de-dup), and subflow stages
    // (runDepth > 0) must NOT emit or a composed flow sprays one event per stage.
    if (sharedState.source !== 'schedule' && (sharedState.runDepth ?? 0) === 0) {
      const lastMsg = sharedState.messages[sharedState.messages.length - 1];
      const outputText =
        lastMsg && lastMsg.role === 'assistant' && typeof lastMsg.content === 'string'
          ? lastMsg.content
          : undefined;
      void publishRunFlowEvent(sharedState, finalStatus, outputText);
    }
  }

  try {
    sharedState.updatedAt = Date.now();
    if (sharedState.title === 'New Conversation' && sharedState.messages.length > 0) {
      const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
      if (firstUserMessage && typeof firstUserMessage.content === 'string') {
        sharedState.title = buildConversationTitle(firstUserMessage.content);
        log.verbose(`Updated conversation title for ${effectiveConvId} before final return to: ${sharedState.title}`);
      }
    }
    await persistState(storageKey, sharedState); // chokepoint refuses ephemeral + deleted states
    log.debug(`Saved final state for conversation ${effectiveConvId} before returning.`);
  } catch (error) {
    log.error(`Failed to save final state for conversation ${effectiveConvId}:`, error);
  }
  // A conversation deleted mid-run must not be resurrected: the persist above is
  // already refused by the tombstone; drop the in-memory state too instead of
  // re-registering it (the DELETE handler kept it alive only so this run — and
  // descendant subflows walking the ancestor chain — could observe the cancel).
  if (isConversationDeleted(effectiveConvId)) {
    FlowExecutor.conversationStates.delete(effectiveConvId);
  } else {
    FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
  }

  // An ephemeral run is transient: drop it from the in-memory map once it
  // reaches a terminal state so isolated/subflow runs don't accumulate.
  const cleanupEphemeral = () => {
    if (ephemeral && (sharedState.status === 'completed' || sharedState.status === 'error')) {
      FlowExecutor.conversationStates.delete(effectiveConvId);
    }
  };

  const baseResult = {
    conversationId: sharedState.conversationId || effectiveConvId,
    messages: sharedState.messages as FlujoChatMessage[],
    usage: sharedState.usage,
    finalAction: currentAction,
    sharedState,
  };

  // --- Paused debug ---
  if (sharedState.status === 'paused_debug') {
    log.info(`Returning paused debug state for conv ${effectiveConvId}`);
    return {
      ...baseResult,
      status: 'paused_debug',
      outputText: '',
      pendingToolCalls: sharedState.pendingToolCalls,
    };
  }

  // --- Error ---
  if (sharedState.status === 'error' || currentAction === ERROR_ACTION) {
    let errorMessage = 'Unknown error during execution';
    let errorDetails: ErrorDetails | undefined = undefined;
    let statusCode = 500;

    if (typeof sharedState.lastResponse === 'object' && sharedState.lastResponse !== null) {
      if ('success' in sharedState.lastResponse && sharedState.lastResponse.success === false && 'error' in sharedState.lastResponse && typeof sharedState.lastResponse.error === 'string') {
        errorMessage = sharedState.lastResponse.error;
        if ('errorDetails' in sharedState.lastResponse && typeof sharedState.lastResponse.errorDetails === 'object' && sharedState.lastResponse.errorDetails !== null) {
          const details = sharedState.lastResponse.errorDetails as Partial<ErrorDetails>;
          errorDetails = {
            message: typeof details.message === 'string' ? details.message : errorMessage,
            type: typeof details.type === 'string' ? details.type : undefined,
            code: typeof details.code === 'string' ? details.code : undefined,
            param: typeof details.param === 'string' ? details.param : undefined,
            status: typeof details.status === 'number' ? details.status : undefined,
            stack: typeof details.stack === 'string' ? details.stack : undefined,
            name: typeof details.name === 'string' ? details.name : undefined,
          };
          if (errorDetails.status) {
            statusCode = errorDetails.status;
          }
        }
      } else {
        try {
          errorMessage = `Unexpected error state object: ${JSON.stringify(sharedState.lastResponse)}`;
        } catch {
          errorMessage = 'Unexpected error state object (unserializable)';
        }
      }
    } else if (typeof sharedState.lastResponse === 'string') {
      errorMessage = sharedState.lastResponse;
    }

    if (!errorDetails) {
      errorDetails = { message: errorMessage };
    } else {
      errorDetails.message = errorDetails.message || errorMessage;
    }

    log.error(`Returning error result for conv ${effectiveConvId}`, { errorMessage, errorDetails, statusCode });

    if (sharedState.status !== 'error') {
      sharedState.status = 'error';
    }

    cleanupEphemeral();
    return {
      ...baseResult,
      status: 'error',
      outputText: '',
      error: { message: errorMessage, details: errorDetails, statusCode },
    };
  }

  // --- Success (Final, Tool Call, Stay, or Awaiting Approval) ---
  const lastMessage = sharedState.messages.length > 0 ? sharedState.messages[sharedState.messages.length - 1] : null;

  let responseContent = '';
  let externalToolsXml = '';

  if (typeof sharedState.lastResponse === 'object' && sharedState.lastResponse !== null && '_flujo_xml_tools' in sharedState.lastResponse) {
    externalToolsXml = sharedState.lastResponse._flujo_xml_tools as string;
    if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
      responseContent = lastMessage.content;
    } else {
      responseContent = '';
    }
    responseContent += (responseContent ? '\n\n' : '') + externalToolsXml;
    sharedState.lastResponse = responseContent;

  } else if (typeof sharedState.lastResponse === 'string') {
    responseContent = sharedState.lastResponse;
  } else if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
    responseContent = lastMessage.content;
  } else {
    responseContent = (currentAction === TOOL_CALL_ACTION && !flujo) ? '' : 'Processing complete.';
  }

  const toolCalls = externalToolsXml
    ? undefined
    : (lastMessage?.role === 'assistant' ? lastMessage.tool_calls : undefined);

  log.info(`Returning success result for conv ${effectiveConvId}`, { action: currentAction, status: sharedState.status, flujo, requireApproval, flujodebug });

  cleanupEphemeral();
  return {
    ...baseResult,
    status: (sharedState.status as FlowRunStatus) || (currentAction === FINAL_RESPONSE_ACTION ? 'completed' : 'running'),
    outputText: responseContent,
    toolCalls,
    pendingToolCalls: sharedState.pendingToolCalls,
  };
}
