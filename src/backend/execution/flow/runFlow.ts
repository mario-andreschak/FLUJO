import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import {
  forget as forgetConversationCacheEntry,
  markTerminal as markConversationTerminal,
  noteWrite as noteConversationWrite,
} from '@/backend/execution/flow/conversationStateCache';
import {
  ownerScopeForRun,
  releaseRunOwnedBashSessions,
} from '@/backend/services/mcp/ownerScope';
import { reconcileConversationLog, recoverMessagesFromLog, repairDanglingToolCalls, appendRawForState } from '@/backend/execution/flow/conversationLog';
import {
  steeringCount,
  takeSteeringMessages,
  requeueSteeringMessages,
} from '@/backend/execution/flow/steeringInbox';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { getFlowRunEventBus, FlowRunFiredBy } from '@/backend/services/scheduler/flowRunEventBus';
import { assertFlowExecutionCurrent } from '@/backend/execution/flow/executionAuthority';
import { EmitFn, type RecoveryLaneIdentity, UsageTotals } from '@/shared/types/execution/events';
import OpenAI from 'openai';
import {
  SharedState,
  type FlowInvocationSource,
  isFlowInvocationSource,
  isUnattendedFlowInvocation,
  TOOL_CALL_ACTION,
  FINAL_RESPONSE_ACTION,
  ERROR_ACTION,
  STAY_ON_NODE_ACTION,
  ErrorDetails,
} from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { requireFunctionToolCalls } from '@/shared/types/openai';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { isMeetingToolName } from '@/backend/execution/flow/handlers/meetingTools';
import { isInternalToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { emitErrorOnce, emitNormalizedErrorOnce, deriveLastErrorFromLastResponse } from '@/backend/execution/flow/normalizeError';
import { flowService } from '@/backend/services/flow/index';
import type { FlowService as FlowServiceType } from '@/backend/services/flow/index';
import { Flow } from '@/shared/types/flow';
import { loadItem as loadItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { FEATURES } from '@/config/features';
import { validateFlowForRun, validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { MAX_SUBFLOW_DEPTH } from '@/backend/execution/flow/constants';
import { isCancelledByAncestry, isConversationDeleted } from '@/backend/execution/flow/cancellation';
import { buildConversationTitle, isDefaultConversationTitle, DEFAULT_CONVERSATION_TITLE } from '@/utils/shared/conversationTitle';
import { setElicitationContext, clearElicitationContext } from '@/backend/services/mcp/elicitationContext';
import { evaluatePermission, extractResource } from '@/backend/execution/flow/permissionEngine';
import { decodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { GRACEFUL_CAP_SUMMARY_INSTRUCTION, GRACEFUL_CAP_TOOL_RESULT } from '@/backend/execution/flow/handlers/gracefulCap';
import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';
import {
  classifyStatisticsError,
  createStatisticsEvent,
  recordStatisticsEvent,
} from '@/backend/services/statistics';
import { statisticsRevisionId } from '@/backend/services/statistics/metadata';
import {
  classifyRecoveryFailure,
  commitRecoveryCheckpoint,
  commitRecoveryTransition,
  commitToolCheckpoint,
  initializeRecovery,
  markDanglingToolEffectsUnknown,
  reconcileInterruptedRecovery,
} from '@/backend/execution/flow/recoveryCheckpoint';
import { queueSubflowRunOutcome } from '@/backend/execution/flow/subflowRecovery';
import { hydrateLazyToolPayloads } from '@/backend/execution/flow/lazyToolPayloads';
import { combineAbortSignals } from '@/backend/execution/flow/combineAbortSignals';
import type { PersonaAttribution } from '@/shared/types/enduringAgent';
import {
  ATTACH_BREAKPOINT,
  matchToolBreakpoint,
  nodeBreakpoints,
} from '@/utils/shared/debugBreakpoints';

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

/** Unattended mode (issue #218): how many times to re-prompt a Process node
 *  that ended on plain text but has MORE THAN ONE forward successor (so the
 *  engine can't pick deterministically) before giving up and completing the
 *  run. The single-forward-successor case never nudges — it auto-advances. */
const UNATTENDED_MAX_NUDGES = 1;

type UnattendedOutcome = 'advanced' | 'nudged' | 'complete';

/**
 * Unattended drive-forward (issue #218). Called when a step returned
 * FINAL_RESPONSE_ACTION (a Process node ended its turn on plain text with no
 * tool call / handoff). In a normal run that silently completes the flow — a
 * problem for headless runs where the model "narrates and stops" instead of
 * handing off, leaving the flow dead halfway (labels not moved, no commit,
 * status reported as success). In UNATTENDED mode:
 *   - exactly ONE forward (non-returning) control successor  -> auto-advance to
 *     it (the author's unambiguous continuation);
 *   - MORE THAN ONE                                          -> re-prompt the
 *     model to hand off, bounded by UNATTENDED_MAX_NUDGES, then complete;
 *   - ZERO (a genuine leaf, e.g. a simple answer flow)       -> complete as
 *     today.
 * "Forward" excludes explicit bidirectional back-edges AND one-way terminal
 * Subflows (both return to their caller rather than progress toward a finish),
 * plus MCP/resource attachments. Only Process nodes are driven; a Finish node
 * reaching FINAL_RESPONSE_ACTION completes normally.
 */
async function unattendedDriveForward(
  state: SharedState,
  emit: EmitFn,
  nudges: Map<string, number>,
): Promise<UnattendedOutcome> {
  if (!state.unattended) return 'complete';

  const nodeId = state.currentNodeId;
  if (!nodeId) return 'complete';

  let flow: Flow | undefined;
  try {
    flow = state.flowSnapshot
      ?? (state.flowId ? (await flowService.getFlow(state.flowId)) ?? undefined : undefined);
  } catch (err) {
    log.debug('[Unattended] flow load failed; completing normally', { err });
    return 'complete';
  }
  if (!flow) return 'complete';

  const node = flow.nodes?.find(n => n.id === nodeId);
  // Only Process nodes stall on plain text. A finish node (or anything else)
  // reaching here means the flow genuinely ended — complete normally.
  if (!node || node.type !== 'process') return 'complete';

  const flowNodes = flow.nodes ?? [];
  const flowEdges = flow.edges ?? [];
  const mcpNodeIds = new Set(flowNodes.filter(n => n.type === 'mcp').map(n => n.id));

  // Mirror FlowConverter's control-successor rules. A Subflow has an explicit
  // onward path when it authors a non-attachment outgoing edge, or when a
  // bidirectional edge pointing at it supplies a reverse successor. Without
  // either, Process -> Subflow is an implicit call/return and must not be
  // mistaken for unattended forward progress.
  const hasRuntimeControlSuccessor = (subflowId: string): boolean =>
    flowEdges.some((edge) => {
      const data = edge.data as { edgeType?: string; bidirectional?: boolean } | undefined;
      const attachment =
        edge.type === 'mcpEdge' ||
        data?.edgeType === 'mcp' ||
        data?.edgeType === 'resource';
      if (attachment) return false;
      return edge.source === subflowId || (edge.target === subflowId && data?.bidirectional === true);
    });

  const isImplicitReturningSubflow = (targetId: string): boolean => {
    const target = flowNodes.find(candidate => candidate.id === targetId);
    return target?.type === 'subflow' && !hasRuntimeControlSuccessor(targetId);
  };

  const forwardTargets = Array.from(
    new Set(
      flowEdges
        .filter(e =>
          e.source === nodeId &&
          e.type !== 'mcpEdge' &&
          (e.data as { edgeType?: string; bidirectional?: boolean } | undefined)?.edgeType !== 'mcp' &&
          (e.data as { edgeType?: string; bidirectional?: boolean } | undefined)?.edgeType !== 'resource' &&
          (e.data as { edgeType?: string; bidirectional?: boolean } | undefined)?.bidirectional !== true &&
          !mcpNodeIds.has(e.target) &&
          !isImplicitReturningSubflow(e.target),
        )
        .map(e => e.target),
    ),
  ).filter(t => flowNodes.some(n => n.id === t));

  if (forwardTargets.length === 1) {
    const nextNodeId = forwardTargets[0];
    log.info(
      `[Unattended] Process node ${nodeId} ended on plain text; auto-advancing to sole forward successor ${nextNodeId} for conv ${state.conversationId}.`,
    );
    const fromNodeId = state.currentNodeId;
    state.currentNodeId = nextNodeId;
    state.handoffRequested = undefined;
    nudges.delete(nodeId);
    emit({
      type: 'handoff',
      from: fromNodeId ? { nodeId: fromNodeId } : undefined,
      toNodeId: nextNodeId,
      edgeId: `unattended-auto:${nodeId}->${nextNodeId}`,
    });
    return 'advanced';
  }

  if (forwardTargets.length > 1) {
    const count = nudges.get(nodeId) ?? 0;
    if (count < UNATTENDED_MAX_NUDGES) {
      nudges.set(nodeId, count + 1);
      log.info(
        `[Unattended] Process node ${nodeId} ended on plain text with ${forwardTargets.length} forward successors; nudging to hand off (attempt ${count + 1}/${UNATTENDED_MAX_NUDGES}).`,
      );
      state.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        content:
          'You ended your turn without calling a tool or handing off, but this is an unattended run that cannot stop at this step. To continue you MUST call one of your handoff tools to route to the next step. If your work at this step is complete, hand off to the finishing/next step now.',
        timestamp: Date.now(),
        processNodeId: nodeId,
      });
      return 'nudged';
    }
    log.warn(
      `[Unattended] Process node ${nodeId} still did not hand off after ${UNATTENDED_MAX_NUDGES} nudge(s); completing the run to avoid a loop.`,
    );
    return 'complete';
  }

  // Zero forward successors: a genuine leaf. Nothing to drive to — complete.
  return 'complete';
}

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
    // Scheduled/triggered runs are filtered out before this is ever called.
    const firedBy: FlowRunFiredBy = state.source === 'chat' ? 'chat' : 'api';
    const trimmed =
      outputText && outputText.length > MAX_EVENT_OUTPUT_CHARS
        ? `${outputText.slice(0, MAX_EVENT_OUTPUT_CHARS)}…`
        : outputText;
    // Flow-name resolution can cross an arbitrary I/O boundary. Check the
    // Activity lease / meeting generation only after it completes and directly
    // before the process-visible publication. Authority loss is caught by this
    // best-effort helper, suppressing the stale event without rejecting runFlow.
    await assertFlowExecutionCurrent(state);
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

export type FlowRunStatus = 'completed' | 'error' | 'awaiting_tool_approval' | 'paused_debug' | 'running' | 'capped';

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
  /** Latest future-turn context supplied by mounted MCP Apps. */
  mcpAppContexts?: import('@/shared/types/chat').McpAppModelContextMap;
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
  /** Stable logical run id supplied by an orchestrator (the scheduler uses its
   * existing RunRecord id). Approval/debug resumes recover it from SharedState. */
  runId?: string;
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
  /** Durable identity for a persisted parallel subflow lane (issue #355). */
  lane?: RecoveryLaneIdentity;
  depth?: number;

  /** Explicit invocation context (issue #113/#339). Required at the runFlow
   *  boundary so unattended behavior can never depend on an omitted default or
   *  a persisted flow property. Chat/API are attended; schedule/trigger,
   *  subflow, MCP, meeting-participant, and internal-tool execution are unattended. */
  source: FlowInvocationSource;
  /** For scheduler-originated runs: the planned execution id that fired this
   *  run (issue #113). Only meaningful when `source === 'schedule'`. */
  plannedExecutionId?: string;
  /** Display-name snapshot for scheduler-originated statistics. */
  plannedExecutionName?: string;
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
  /** External owner cancellation (for example MeetingEngine). Runtime-only. */
  abortSignal?: AbortSignal;

  /**
   * Runtime-only higher-level authority (Persona Activity lease/fence). It is
   * asserted before model/tool dispatch and attributed conversation writes,
   * and is never persisted or exposed to the model.
   */
  executionAuthority?: import('./types').FlowExecutionAuthority;

  /**
   * Trusted, capability-free Persona attribution. Persona-aware adapters set
   * this only after claiming an Activity; arbitrary request bodies must never
   * be forwarded here as authoritative attribution.
   */
  personaAttribution?: PersonaAttribution;

  /** MeetingEngine-only participant identity. Never forwarded to subflows. */
  meetingParticipant?: SharedState['meetingParticipant'];
  /** MeetingEngine-only fresh action buffer for this participant turn. */
  meetingTurn?: SharedState['meetingTurn'];
}

export interface FlowRunResult {
  status: FlowRunStatus;
  conversationId: string;
  /** Metadata-only logical run identity, stable across approval/debug resume. */
  runId: string;
  /** Final assistant content (the default "output"), post external-tool XML wrap. */
  outputText: string;
  /** Provider-neutral media attached to the final assistant output. */
  outputMedia?: ModelMediaPart[];
  /** Tool calls to surface in a tool-calls response (undefined when XML-wrapped). */
  toolCalls?: OpenAI.ChatCompletionMessageFunctionToolCall[];
  /** Full transcript of THIS run. */
  messages: FlujoChatMessage[];
  /** Aggregated token/cost totals for the run. */
  usage?: UsageTotals;
  pendingToolCalls?: OpenAI.ChatCompletionMessageFunctionToolCall[];
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
  if (!input.conversationId) return runFlowUnlocked(input);
  return withConversationExecutionLock(
    input.conversationId,
    () => runFlowUnlocked(input),
  );
}

async function runFlowUnlocked(input: FlowRunInput): Promise<FlowRunResult> {
  if (!isFlowInvocationSource(input.source)) {
    throw new TypeError(
      `runFlow requires an explicit invocation source (${String(input.source)} is invalid)`,
    );
  }
  if (input.source === 'meeting' && (!input.meetingParticipant || !input.meetingTurn)) {
    throw new TypeError('Meeting flow runs require participant and turn coordination context.');
  }
  if (input.personaAttribution && !input.executionAuthority) {
    throw new TypeError('Persona-attributed flow runs require execution authority.');
  }

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
        const mayRecoverPersonaState = !loadedState.personaAttribution || (
          input.personaAttribution?.personaId === loadedState.personaAttribution.personaId
          && Boolean(input.executionAuthority)
        );
        if (loadedState.personaAttribution && mayRecoverPersonaState) {
          Object.defineProperty(loadedState, 'executionAuthority', {
            value: input.executionAuthority,
            enumerable: false,
            configurable: true,
            writable: true,
          });
        }
        if (mayRecoverPersonaState) {
          // Per-step durability lives in the append-only log; the snapshot is
          // only written at run boundaries. Fold in anything it missed (e.g. a
          // crash mid-run after messages were streamed/appended). Persona
          // recovery happens only after the dispatcher authority is installed.
          await recoverMessagesFromLog(loadedState);
          await reconcileInterruptedRecovery(storageKey, loadedState);
          FlowExecutor.conversationStates.set(effectiveConvId, loadedState);
        }
      } else {
        log.info(`No state found in storage for conversation: ${effectiveConvId}. Will create new state.`);
      }
    } catch (error) {
      log.warn(`Error loading conversation state from storage for ${effectiveConvId}:`, error);
    }
  }

  // Meeting participant conversations remain inspectable, but an ordinary
  // chat/API run must not mutate their memory while their owning meeting can
  // still schedule another turn. The shared execution lease above makes this
  // check race-free with an in-flight participant turn.
  if (loadedState?.meetingParticipant && input.source !== 'meeting') {
    const { getMeeting } = await import('@/backend/services/meetings/store');
    const owner = await getMeeting(loadedState.meetingParticipant.meetingId);
    if (
      owner
      && owner.status !== 'completed'
      && owner.status !== 'cancelled'
      && owner.status !== 'error'
    ) {
      throw new Error(
        `Conversation ${effectiveConvId} is reserved by active meeting ${owner.id}.`,
      );
    }
  }

  // A Persona-owned conversation may only be resumed by the trusted
  // dispatcher after it reacquires an Activity lease. This blocks legacy
  // debug/approval/chat paths from accidentally continuing Persona work with
  // no fence. A later Activity for the same Persona may intentionally replace
  // the previous activity/revision attribution on a new turn.
  if (loadedState?.personaAttribution) {
    if (!input.personaAttribution || !input.executionAuthority) {
      throw new Error(
        `Conversation ${effectiveConvId} is Persona-owned and must be resumed through the Persona dispatcher.`,
      );
    }
    if (loadedState.personaAttribution.personaId !== input.personaAttribution.personaId) {
      throw new Error(`Conversation ${effectiveConvId} belongs to a different Persona.`);
    }
    Object.defineProperty(loadedState, 'executionAuthority', {
      value: input.executionAuthority,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  // Approval/debug resumes are continuations of the same logical run. A new
  // user turn on a completed/error conversation receives a fresh id below.
  const resumingPausedLogicalRun = Boolean(
    !userTurn
    &&
    loadedState?.logicalRunId
    && (
      loadedState.status === 'awaiting_tool_approval'
      || loadedState.status === 'paused_debug'
      || loadedState.debugResumeAfterDetach
    )
  );

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
      sharedState.lastError = undefined;
      sharedState.errorEventEmitted = false;
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
      sharedState.lastError = undefined;
      sharedState.errorEventEmitted = false;
      sharedState.pendingToolCalls = undefined;
      sharedState.handoffRequested = undefined;
      sharedState.debugPendingAction = undefined;
      sharedState.debugPendingToolCalls = undefined;
      sharedState.debugPauseRequested = false;
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
      title: input.title?.trim() || DEFAULT_CONVERSATION_TITLE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugMode: flujodebug,
      executionTrace: (flujodebug && FEATURES.ENABLE_EXECUTION_TRACKER) ? [] : undefined,
      // Tier 2c: the run-scoped named-variable scratchpad starts empty and is
      // seeded from FlowRunInput.variables just below.
      variables: {},
    };
  }

  // `injectOnce` applies to this top-level user turn. Keep the map across
  // approval/debug continuations, but clear it before a new turn re-enters the
  // flow so persisted conversation state cannot suppress a later traversal.
  if (userTurn && !resumingPausedLogicalRun && !input.parentRunId && (input.depth ?? 0) === 0) {
    sharedState.staticInjected = undefined;
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

  // MCP Apps: each ui/update-model-context request overwrites that app's
  // previous value in the frontend-owned map. When the map accompanies a
  // future user turn, replace the persisted snapshot atomically; omission means
  // an internal resume should keep the last snapshot.
  if (input.mcpAppContexts !== undefined) {
    sharedState.mcpAppContexts = input.mcpAppContexts;
  }

  // Never inherit a stale in-memory authority from an earlier invocation. A
  // paused Persona Activity must be explicitly reacquired by its dispatcher;
  // ordinary/legacy resumes remain authority-free.
  if (input.executionAuthority) {
    Object.defineProperty(sharedState, 'executionAuthority', {
      value: input.executionAuthority,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } else {
    delete sharedState.executionAuthority;
  }
  if (input.personaAttribution) {
    sharedState.personaAttribution = { ...input.personaAttribution };
  }
  // A meeting round is still executed by the regular flow runtime, but its
  // coordination state belongs to the sibling MeetingEngine. Install only the
  // participant's identity and a fresh per-turn action buffer here; because
  // SubflowNode does not forward these fields, child runs cannot accidentally
  // speak or vote on behalf of their parent participant.
  if (input.source === 'meeting' && input.meetingParticipant && input.meetingTurn) {
    sharedState.meetingParticipant = { ...input.meetingParticipant };
    sharedState.meetingTurn = {
      ...input.meetingTurn,
      actions: [...input.meetingTurn.actions],
    };
  } else {
    // Participant conversations are ordinary inspectable conversations once
    // a person re-enters them outside the coordinator. Do not leave stale
    // meeting capabilities or provider prefixes armed on a later chat/API run.
    // The frozen prompt and native session were created with the meeting
    // protocol, so both must be rebuilt before normal conversation continues.
    if (sharedState.meetingParticipant) {
      sharedState.frozenSystemPrompts = undefined;
      sharedState.codexSessions = undefined;
    }
    sharedState.meetingTurn = undefined;
  }

  // The conversation's approval setting (single source of truth).
  sharedState.requireApproval = requireApproval;

  // Tag the invocation origin and derive the run-local unattended flag from it
  // (issue #339).
  //
  // `source` is the CONVERSATION's provenance and is immutable once recorded:
  // it answers "what created this conversation", not "how was it re-entered".
  // Every resume path — approval release, debug step/continue, respond — goes
  // back through chatCompletionService, which hardcodes source:'chat'. Blindly
  // overwriting therefore relabelled a scheduled/triggered run as a user chat
  // (wrong origin badge, wrong "by origin" bucket) AND, worse, bypassed the
  // `source !== 'schedule' && source !== 'trigger'` guard on the run:done emit
  // below, so a scheduler-owned run that happened to pause for approval sprayed
  // a duplicate flow-run event on resume. Keep the first origin; only fill it
  // in when absent (fresh state, or a legacy record from before this field).
  sharedState.source = sharedState.source ?? input.source;
  // `unattended`, by contrast, stays strictly RUN-local and is always derived
  // from THIS invocation: a human releasing an approval on a scheduled run is
  // genuinely attended for that turn. Overwritten every call so a legacy
  // persisted value or a flow-level property can never influence this run.
  sharedState.unattended = isUnattendedFlowInvocation(input.source);
  if (input.plannedExecutionId) {
    sharedState.plannedExecutionId = input.plannedExecutionId;
  }
  if (input.plannedExecutionName) {
    sharedState.statisticsPlannedExecutionName = input.plannedExecutionName;
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
    // Conversation-level parent link (issue #182): formalize the subflow
    // parentage at the conversation record so the chat sidebar can render
    // Flow->Subflow->... chains without reverse-engineering run internals.
    // Additive/optional -- a conversation without these fields renders as a
    // root, so no migration is needed. Compute rootConversationId eagerly
    // (O(1) sidebar grouping) from the parent's own root, falling back to the
    // parent id when the parent state isn't resident (treat parent as root).
    sharedState.parentConversationId = input.parentRunId;
    if (!sharedState.rootConversationId) {
      const parentState = FlowExecutor.conversationStates.get(input.parentRunId);
      sharedState.rootConversationId =
        parentState?.rootConversationId ?? parentState?.conversationId ?? input.parentRunId;
    }
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

  if (!resumingPausedLogicalRun) {
    sharedState.logicalRunId = input.runId ?? crypto.randomUUID();
    sharedState.statisticsRunStartedAt = Date.now();
    sharedState.statisticsRunStarted = false;
    sharedState.statisticsRunFinished = false;
    sharedState.statisticsFlowName = input.flowDefinition?.name
      ?? (input.modelName?.startsWith('flow-') ? input.modelName.slice(5) : undefined);
    sharedState.statisticsPlannedExecutionName = input.plannedExecutionName;
  }
  const logicalRunId = sharedState.logicalRunId ?? input.runId ?? crypto.randomUUID();
  sharedState.logicalRunId = logicalRunId;
  sharedState.debugResumeAfterDetach = false;
  sharedState.statisticsRunStartedAt ??= Date.now();
  initializeRecovery(sharedState, logicalRunId);
  if (input.lane) sharedState.subflowLane = input.lane;
  if (sharedState.subflowLane) sharedState.recovery!.lane = sharedState.subflowLane;
  const flowSnapshot = () => ({
    id: sharedState.flowId || input.flowId || input.flowDefinition?.id || input.modelName || 'unknown',
    name: sharedState.statisticsFlowName ?? sharedState.flowSnapshot?.name ?? input.flowDefinition?.name,
  });
  const plannedExecution = sharedState.plannedExecutionId
    ? {
        id: sharedState.plannedExecutionId,
        name: sharedState.statisticsPlannedExecutionName,
      }
    : undefined;
  // Lineage: the spawning run's logical id travels with every lifecycle record
  // so a child run can be rolled up under its parent without in-memory state.
  const runRevisions = () => (sharedState.statisticsFlowRevisionId
    ? { flowRevisionId: sharedState.statisticsFlowRevisionId }
    : undefined);
  const ensureRunStarted = () => {
    if (sharedState.statisticsRunStarted) return;
    recordStatisticsEvent(createStatisticsEvent({
      type: 'run.started',
      runId: logicalRunId,
      source: input.source,
      flow: flowSnapshot(),
      plannedExecution,
      conversationId: effectiveConvId,
      parentRunId: sharedState.parentRunId,
      revisions: runRevisions(),
    }));
    sharedState.statisticsRunStarted = true;
  };

  const finalizeRun = (result: Omit<FlowRunResult, 'runId'>): FlowRunResult => {
    ensureRunStarted();
    const durationMs = Math.max(0, Date.now() - (sharedState.statisticsRunStartedAt ?? startTime));
    if (result.status === 'awaiting_tool_approval' || result.status === 'paused_debug') {
      recordStatisticsEvent(createStatisticsEvent({
        type: 'run.paused',
        runId: logicalRunId,
        source: input.source,
        flow: flowSnapshot(),
        plannedExecution,
        pauseKind: result.status === 'paused_debug' ? 'debug' : 'approval',
        durationMs,
        parentRunId: sharedState.parentRunId,
        revisions: runRevisions(),
      }));
    } else if (!sharedState.statisticsRunFinished) {
      const outcome = sharedState.isCancelled
        ? 'cancelled' as const
        : result.status === 'error'
          ? 'error' as const
          : result.status === 'capped' || sharedState.capped
            ? 'capped' as const
            : 'completed' as const;
      recordStatisticsEvent(createStatisticsEvent({
        type: 'run.finished',
        runId: logicalRunId,
        source: input.source,
        flow: flowSnapshot(),
        plannedExecution,
        outcome,
        durationMs,
        parentRunId: sharedState.parentRunId,
        revisions: runRevisions(),
        errorClass: outcome === 'error' ? classifyStatisticsError(result.error) : undefined,
        usage: result.usage ? {
          inputTokens: result.usage.promptTokens,
          outputTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          cachedInputTokens: result.usage.cacheReadTokens,
          cacheWriteTokens: result.usage.cacheWriteTokens,
        } : undefined,
      }));
      sharedState.statisticsRunFinished = true;
    }
    const finalized = { ...result, runId: logicalRunId };
    queueSubflowRunOutcome(finalized);
    return finalized;
  };

  if (sharedState.runDepth > MAX_SUBFLOW_DEPTH) {
    log.error(`runFlow aborted: subflow depth ${sharedState.runDepth} exceeds max ${MAX_SUBFLOW_DEPTH}`);
    sharedState.status = 'error';
    return finalizeRun({
      status: 'error',
      conversationId: effectiveConvId,
      outputText: '',
      messages: sharedState.messages,
      error: { message: `Subflow recursion limit (${MAX_SUBFLOW_DEPTH}) exceeded`, statusCode: 500 },
      finalAction: ERROR_ACTION,
      sharedState,
    });
  }

  // Conversation GET responses may carry short display previews for large tool
  // bodies. Restore those references before the client history can replace the
  // canonical transcript (also covers a split copied into a new conversation).
  if (data.messages?.length) {
    data.messages = await hydrateLazyToolPayloads(
      data.messages,
      sharedState.messages ?? [],
      effectiveConvId,
      sharedState,
    );
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
        return finalizeRun({
          status: 'error',
          conversationId: effectiveConvId,
          outputText: '',
          messages: sharedState.messages,
          flowNotFound: { name: flowName },
          error: { message: `Flow not found: ${flowName}`, statusCode: 400 },
          finalAction: ERROR_ACTION,
          sharedState,
        });
      }
      resolvedFlowId = reactFlow.id;
    }
    if (!resolvedFlowId) {
      log.error('No flow specified for run (neither flowId nor model provided).');
      return finalizeRun({
        status: 'error',
        conversationId: effectiveConvId,
        outputText: '',
        messages: sharedState.messages,
        error: { message: 'No flow specified (provide flowId or model).', statusCode: 400 },
        finalAction: ERROR_ACTION,
        sharedState,
      });
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
    // Stamp lastUserMessageAt for the initial user turn
    const _initLastUser = [...initialMessages].reverse().find(m => m.role === 'user');
    if (_initLastUser) {
      sharedState.lastUserMessageAt = _initLastUser.timestamp ?? Date.now();
    }

    try {
      sharedState.updatedAt = Date.now();
      if (isDefaultConversationTitle(sharedState.title) && sharedState.messages.length > 0) {
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
      // Stamp lastUserMessageAt whenever a user turn is received
      if (userTurn) {
        const _existLastUser = [...sharedState.messages].reverse().find(m => m.role === 'user');
        if (_existLastUser) {
          sharedState.lastUserMessageAt = _existLastUser.timestamp ?? Date.now();
        }
      }
    }
    if (userTurn || sharedState.debugMode === undefined) {
      sharedState.debugMode = flujodebug;
    }
    if (userTurn) {
      // A real message is allowed to recover a conversation whose debugger UI
      // was closed/reloaded while the run was parked. Treat it as a fresh run,
      // not as a hidden debugger resume: clear the parked status and, unless the
      // caller explicitly requested debugging again, disarm old breakpoints.
      if (sharedState.status === 'paused_debug') {
        sharedState.status = 'running';
        sharedState.lastResponse = undefined;
        sharedState.lastError = undefined;
        sharedState.errorEventEmitted = false;
        sharedState.isCancelled = false;
      }
      if (!flujodebug) {
        sharedState.breakpoints = [];
        sharedState.lastBreakNodeId = undefined;
      }
      sharedState.debugPendingToolCalls = undefined;
      sharedState.debugPendingAction = undefined;
      sharedState.debugPauseRequested = false;
    }
    if (sharedState.debugMode) {
      if (FEATURES.ENABLE_EXECUTION_TRACKER && !sharedState.executionTrace) {
        sharedState.executionTrace = [];
      }
    }
  }

  if (
    sharedState.flowId
    && (!sharedState.statisticsFlowName || !sharedState.statisticsFlowRevisionId)
  ) {
    try {
      const savedFlow = await flowService.getFlow(sharedState.flowId);
      sharedState.statisticsFlowName ??= savedFlow?.name;
      // Opaque, installation-local fingerprint of the SAVED flow configuration
      // (graph plus node configuration). The configuration itself is never
      // persisted; the fingerprint only makes revisions comparable over time.
      if (savedFlow && !sharedState.statisticsFlowRevisionId) {
        sharedState.statisticsFlowRevisionId = await statisticsRevisionId('flow', {
          id: savedFlow.id,
          nodes: savedFlow.nodes,
          edges: savedFlow.edges,
        });
      }
    } catch {
      // Snapshot names are best-effort; the stable flow id remains authoritative.
    }
  }
  ensureRunStarted();

  // --- Bring the append-only conversation log in line with this turn's input ---
  // Bootstraps the log for brand-new/legacy conversations and records the diff
  // (new turns, edits, pruned messages) for logged ones, BEFORE any run event
  // is emitted. Ephemeral runs are refused inside. Advisory on failure: the
  // legacy SharedState persistence below still covers the conversation.
  try {
    await reconcileConversationLog(sharedState, messagesBeforeTurn);
    // Issue #256: heal any assistant tool_calls turn left unanswered by a
    // crash/restart mid-tool before the run loop builds a provider request.
    // Persist each synthetic result via the log-only path so the projection is
    // self-healing and the repair is auditable in the transcript.
    const repaired = repairDanglingToolCalls(sharedState);
    if (repaired.length) {
      log.info(`Repaired ${repaired.length} dangling tool call(s) for ${effectiveConvId} at run start (issue #256).`);
      markDanglingToolEffectsUnknown(sharedState, 'running');
      await appendRawForState(sharedState, [
        ...repaired.map(m => ({ type: 'message' as const, message: m })),
        { type: 'recovery:checkpoint', checkpoint: sharedState.recovery!.currentCheckpoint! },
        { type: 'recovery:transition', recovery: { ...sharedState.recovery! } },
      ]);
    }
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
  // Unattended drive-forward (issue #218): per-node nudge counter, run-scoped
  // (a resume starts fresh). Keyed by the Process node id that stalled.
  const unattendedNudges = new Map<string, number>();
  // Graceful landing (issue #253): per-node agentic-turn counter for the
  // request/response tool loop. Incremented each time the loop re-enters with a
  // tool-call action for the same Process node; once it reaches that node's
  // resolved turn budget we force a final text-only summary instead of running
  // more tools. Run-scoped (a resume starts fresh).
  const nodeTurnCounts = new Map<string, number>();

  // --- Execution event emission (live progress + debugger) ---
  const emit: EmitFn = input.emit ?? executionEventBus.emitterFor(effectiveConvId);
  // A custom emitter forwards child events onto the parent channel. Recovery
  // records for persisted children must instead append to the child's own log;
  // omitting the emitter selects that direct durable path.
  const recoveryEmit: EmitFn | undefined = input.emit ? undefined : emit;
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
    const msgCacheWrite = msg.usage.cacheWriteTokens ?? 0;
    if (msgCacheWrite) totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + msgCacheWrite;
    const nodeKey = msg.processNodeId || 'unknown';
    const node = totals.byNode[nodeKey] ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
    node.promptTokens += msg.usage.promptTokens;
    node.completionTokens += msg.usage.completionTokens;
    node.totalTokens += msg.usage.totalTokens;
    if (msgCacheRead) node.cacheReadTokens = (node.cacheReadTokens ?? 0) + msgCacheRead;
    if (msgCacheWrite) node.cacheWriteTokens = (node.cacheWriteTokens ?? 0) + msgCacheWrite;
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
      ...(msgCacheWrite ? { cacheWriteTokens: msgCacheWrite } : {}),
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
  await commitRecoveryTransition(storageKey, sharedState, 'running', {}, recoveryEmit);

  // --- Elicitation context: bind active run to each MCP server in this flow ---
  // The elicitation handler (registered at connect time) looks up the active
  // conversationId + unattended flag here when a server calls elicitation/create.
  const elicitationServerNames: string[] = [];
  if (sharedState.flowId) {
    try {
      const elicitFlow = sharedState.flowSnapshot ?? await flowService.getFlow(sharedState.flowId);
      if (elicitFlow) {
        for (const node of elicitFlow.nodes || []) {
          const serverName = node.data?.properties?.boundServer as string | undefined;
          if (node.data?.type === 'mcp' && serverName) {
            elicitationServerNames.push(serverName);
            setElicitationContext(serverName, {
              conversationId: effectiveConvId,
              getUnattended: () => !!(sharedState.unattended),
            });
          }
        }
      }
    } catch (err) {
      log.debug('Could not enumerate MCP servers for elicitation context; skipping', { err });
    }
  }

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
  let cancelledByAncestor = false;
  const runtimeAbortSignal = combineAbortSignals(
    input.abortSignal,
    input.executionAuthority?.signal,
  );
  const runCancelled = (): boolean => {
    if (runtimeAbortSignal?.aborted) {
      sharedState.isCancelled = true;
      return true;
    }
    if (sharedState.isCancelled) return true;
    if (isCancelledByAncestry(sharedState.parentRunId, FlowExecutor.conversationStates)) {
      cancelledByAncestor = true;
      sharedState.isCancelled = true;
      return true;
    }
    return false;
  };

  const processToolCallsRecoverably = async (
    args: Parameters<typeof ModelHandler.processToolCalls>[0],
  ): ReturnType<typeof ModelHandler.processToolCalls> => {
    await commitToolCheckpoint(storageKey, sharedState, args.toolCalls, 'before', recoveryEmit);
    try {
      const result = await ModelHandler.processToolCalls({
        ...args,
        signal: combineAbortSignals(args.signal, runtimeAbortSignal),
        beforeToolDispatch: input.executionAuthority?.assertCurrent,
        executionAuthority: sharedState.executionAuthority,
        personaAttribution: sharedState.personaAttribution,
      });
      if (!result.success) {
        await commitToolCheckpoint(storageKey, sharedState, args.toolCalls, 'unknown', recoveryEmit);
      }
      return result;
    } catch (error) {
      await commitToolCheckpoint(storageKey, sharedState, args.toolCalls, 'unknown', recoveryEmit);
      throw error;
    }
  };

  // --- Mid-run steering (user intervention while the run is in flight) --------
  // A correction is only useful if it reaches the model that is going the wrong
  // way, so messages posted to /inject are folded into THIS run at the next safe
  // boundary rather than queued for a run of their own.
  //
  // "Safe" means the transcript is well-formed: an assistant `tool_calls` turn
  // whose results have not been appended yet must never be split by a user
  // message (every provider 400s on that shape — the same invariant issue #256
  // repairs after a crash). When the tail is mid-exchange we simply leave the
  // messages in the inbox and try again on the next iteration, which is at most
  // one tool batch away. This is also what defers a drain past the debug
  // pending-tool-calls step below.
  const hasUnansweredToolCalls = (): boolean => {
    const answered = new Set<string>();
    for (const m of sharedState.messages) {
      if (m.role === 'tool') {
        const id = (m as { tool_call_id?: string }).tool_call_id;
        if (id) answered.add(id);
      }
    }
    return sharedState.messages.some(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((tc) => tc.id && !answered.has(tc.id)),
    );
  };

  /**
   * Fold any waiting steering messages into the live transcript. Returns true
   * when at least one was folded in (the caller keeps executing so the model
   * sees it on its very next call). Ephemeral subflow child runs are keyed by
   * their own id and never receive injections — a message steers the root
   * conversation, and arrives when the subflow returns to it.
  */
  const drainSteering = async (): Promise<boolean> => {
    if (hasUnansweredToolCalls()) {
      log.debug(`Steering message(s) waiting for ${effectiveConvId} but a tool exchange is in flight; deferring.`);
      return false;
    }
    // Persona deliveries remain pending in the durable mailbox until this
    // transcript-safe boundary consumes and acknowledges their stable ids.
    // Generic fence assertions intentionally have no delivery side effects.
    await sharedState.executionAuthority?.pollRelatedInputs?.();
    if (steeringCount(effectiveConvId) === 0) return false;
    const injected = takeSteeringMessages(effectiveConvId);
    if (injected.length === 0) return false;
    const existingIds = new Set(sharedState.messages
      .map((message) => message.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0));
    const newlyFolded = injected.filter((message) =>
      !message.id || !existingIds.has(message.id));
    let foldedDurably = newlyFolded.length === 0;
    try {
      // Stamp the current node so the message is attributed to the step it is
      // steering (live-view lane placement + subflow projection tagging).
      for (const m of newlyFolded) {
        if (!m.processNodeId && sharedState.currentNodeId) m.processNodeId = sharedState.currentNodeId;
      }
      if (newlyFolded.length > 0) {
        sharedState.messages.push(...newlyFolded);
        sharedState.lastUserMessageAt = newlyFolded[newlyFolded.length - 1].timestamp ?? Date.now();
        FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
        emitNewMessages();
        // Per-step durability is the append-only log, exactly as for tool
        // results (the log refuses ephemeral runs, which have no transcript).
        if (!sharedState.ephemeral) {
          await appendRawForState(
            sharedState,
            newlyFolded.map(message => ({ type: 'message', message })),
          );
        }
        foldedDurably = true;
      }
      const stableIds = injected
        .map((message) => message.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (stableIds.length > 0) {
        await sharedState.executionAuthority?.acknowledgeRelatedInputs?.(stableIds);
      }
      log.info(`Folded ${newlyFolded.length} steering message(s) into the live run for ${effectiveConvId}.`);
      return newlyFolded.length > 0;
    } catch (error) {
      // If transcript persistence failed, undo the in-memory fold before
      // retrying. If only the durable mailbox ACK failed, keep the already
      // persisted fold; the next poll is deduplicated by stable message id and
      // retries acknowledgement without appending a second copy.
      if (!foldedDurably && newlyFolded.length > 0) {
        sharedState.messages.splice(
          Math.max(0, sharedState.messages.length - newlyFolded.length),
          newlyFolded.length,
        );
        FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      }
      requeueSteeringMessages(effectiveConvId, injected);
      log.warn(`Failed to fold steering message(s) for ${effectiveConvId}; re-queued`, error);
      return false;
    }
  };

  const singleStep = !!sharedState.debugMode && !continueDebug;
  /** The tool breakpoint (if any) armed for this batch of tool calls. Decodes
   *  namespaced MCP names so `tool:read_file` matches `mcp_<slug>_<hash>`. */
  const matchedToolBreakpointName = (toolCalls: readonly { function?: { name?: string } }[] | undefined) =>
    matchToolBreakpoint(
      sharedState.breakpoints,
      toolCalls,
      (name) => decodeToolName(name, sharedState.toolNameMap),
    );
  const hasAttachRequest = () =>
    !!sharedState.debugPauseRequested
    || !!sharedState.breakpoints?.includes(ATTACH_BREAKPOINT);
  const consumeAttachRequest = () => {
    const requested = hasAttachRequest();
    if (!requested) return false;
    sharedState.debugPauseRequested = false;
    // Backward compatibility for clients that still arm the legacy sentinel.
    sharedState.breakpoints = (sharedState.breakpoints ?? []).filter(b => b !== ATTACH_BREAKPOINT);
    return true;
  };
  const pauseForDebug = (options: {
    reason?: 'debug' | 'breakpoint';
    phase?: 'before-node' | 'after-model' | 'before-tool' | 'after-tool' | 'before-handoff';
    nodeId?: string;
    kind?: 'node' | 'tool' | 'attach';
    toolName?: string;
  } = {}) => {
    const nodeId = options.nodeId ?? sharedState.currentNodeId;
    sharedState.status = 'paused_debug';
    sharedState.debugMode = true;
    if (options.kind && nodeId) {
      emit({
        type: 'breakpoint:hit',
        node: { nodeId },
        kind: options.kind,
        ...(options.toolName ? { toolName: options.toolName } : {}),
      });
    }
    emit({
      type: 'run:paused',
      reason: options.reason ?? 'debug',
      ...(nodeId ? { node: { nodeId } } : {}),
      ...(options.phase ? { phase: options.phase } : {}),
      ...(options.toolName ? { toolName: options.toolName } : {}),
    });
  };
  const pauseForAttachAtSafePoint = async (
    phase: 'before-node' | 'after-model' | 'before-tool' | 'after-tool' | 'before-handoff',
  ): Promise<boolean> => {
    if (!consumeAttachRequest()) return false;
    pauseForDebug({ reason: 'breakpoint', phase, kind: 'attach' });
    FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
    try {
      sharedState.updatedAt = Date.now();
      await persistState(storageKey, sharedState);
    } catch (error) {
      log.error(`Failed to save state while attaching debugger for conv ${effectiveConvId}:`, error);
    }
    return true;
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

        // A heartbeat can fail or another owner can recover an expired lease
        // between loop iterations without this process receiving an abort event.
        // Verify the authoritative fence before doing more Persona work.
        await input.executionAuthority?.assertCurrent();

        // Mid-run steering: deliver anything the user sent while this run has
        // been working, BEFORE the next model call, so the correction lands on
        // the very next turn instead of after the run finishes. Deferred
        // automatically while a tool exchange is unresolved (see drainSteering).
        // The first iteration also picks up anything left over from a previous
        // run that ended before its inbox was drained.
        await drainSteering();

        // A completed model turn can be parked before its action is applied.
        // Consume that action exactly once on resume instead of calling the
        // model again and potentially producing a different decision.
        let actionReadyFromDebugPause = false;
        if (sharedState.debugPendingAction) {
          currentAction = sharedState.debugPendingAction.action;
          sharedState.debugPendingAction = undefined;
          actionReadyFromDebugPause = true;
          log.info(`[Debug Resume] Applying pending action "${currentAction}" for conv ${effectiveConvId}.`);
        }

        // Debug step granularity: execute tool calls a previous step paused before.
        if (!actionReadyFromDebugPause && sharedState.debugPendingToolCalls && sharedState.debugPendingToolCalls.length > 0) {
          const pendingCalls = sharedState.debugPendingToolCalls;
          sharedState.debugPendingToolCalls = undefined;
          log.info(`[Debug Step] Executing ${pendingCalls.length} pending tool call(s) for conv ${effectiveConvId}.`);
          const toolProcessingResult = await processToolCallsRecoverably({
            toolCalls: pendingCalls, toolNameMap: sharedState.toolNameMap, emit,
            // Run-resource auto-capture: ephemeral (subflow-child) runs never
            // write resources — same policy as persistConversationState.
            conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
            runId: logicalRunId,
            node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
            shouldAbort: runCancelled,
            mcpNodes: sharedState.currentMCPNodes, // Issue #239: native resource tools
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
          await commitToolCheckpoint(storageKey, sharedState, pendingCalls, 'completed', recoveryEmit);
          try {
            sharedState.updatedAt = Date.now();
            await persistState(storageKey, sharedState); // chokepoint refuses ephemeral states
          } catch (error) {
            log.error(`Failed to save state after debug tool execution for conv ${effectiveConvId}:`, error);
          }
          const attachedAfterTool = await pauseForAttachAtSafePoint('after-tool');
          if (singleStep && !attachedAfterTool) {
            log.info(`[Debug Step] Paused after tool execution for conv ${effectiveConvId}.`);
            pauseForDebug({ phase: 'after-tool' });
          }
          if (singleStep || attachedAfterTool) break;
          continue;
        }

        if (!actionReadyFromDebugPause) {
        // Breakpoint check (node-scoped; `tool:` breakpoints are evaluated after
        // the model returns, before any resulting action is applied).
        const armedNodeBreakpoints = nodeBreakpoints(sharedState.breakpoints);
        const attachArmed = hasAttachRequest();
        if (!singleStep && (armedNodeBreakpoints.length > 0 || attachArmed)) {
          const nextNodeId = await FlowExecutor.peekNextNodeId(sharedState);
          // '*' is a one-shot "attach" breakpoint set by the Debugger button
          // (setBreakpoints(convId, ['*'])): pause before whatever node comes
          // next, then consume the sentinel so a subsequent Continue resumes
          // normally instead of re-pausing at every node.
          const wildcard = attachArmed;
          const hit = !!nextNodeId && (wildcard || armedNodeBreakpoints.includes(nextNodeId));
          if (hit && (attachArmed || sharedState.lastBreakNodeId !== nextNodeId)) {
            if (wildcard) {
              consumeAttachRequest();
            }
            log.info(`Breakpoint hit at node ${nextNodeId}${wildcard ? ' (attach)' : ''} for conv ${effectiveConvId}. Pausing.`);
            sharedState.lastBreakNodeId = nextNodeId;
            pauseForDebug({
              reason: 'breakpoint',
              phase: 'before-node',
              nodeId: nextNodeId,
              kind: wildcard ? 'attach' : 'node',
            });
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

        // 2a. Execute one step of the flow. Recovery checkpoints deliberately
        // order journal append before snapshot persistence, so a restart can
        // always select the latest fully committed safe boundary.
        const checkpointNodeId = await FlowExecutor.peekNextNodeId(sharedState)
          ?? sharedState.currentNodeId;
        await commitRecoveryCheckpoint(storageKey, sharedState, {
          phase: 'node:before',
          nodeId: checkpointNodeId,
          safe: true,
        }, recoveryEmit);
        const assistantMessageIdBeforeStep = [...sharedState.messages].reverse().find(
          message => message.role === 'assistant',
        )?.id;
        const stepResult = await FlowExecutor.executeStep(sharedState, emit);
        sharedState = stepResult.sharedState;
        currentAction = stepResult.action;
        emitNewMessages();
        if (currentAction !== ERROR_ACTION) {
          await commitRecoveryCheckpoint(storageKey, sharedState, {
            phase: 'node:after',
            nodeId: checkpointNodeId,
            safe: true,
          }, recoveryEmit);
        }
        sharedState.updatedAt = Date.now();
        if (isDefaultConversationTitle(sharedState.title) && sharedState.messages.length > 0) {
          const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
          if (firstUserMessage && typeof firstUserMessage.content === 'string') {
            sharedState.title = buildConversationTitle(firstUserMessage.content);
            log.verbose(`Updated conversation title for ${effectiveConvId} after step ${internalIterations} to: ${sharedState.title}`);
          }
        }

        log.info(`Step ${internalIterations} completed for conv ${effectiveConvId}. Action: ${currentAction}`, { currentNodeId: sharedState.currentNodeId });
        log.verbose(`Shared state after step ${internalIterations}`, sharedState);

        // A Process node execution is one complete model turn. Park HERE —
        // after the assistant narration/tool arguments are durable, but before
        // tools, approvals, handoffs, or finalization consume its action. This
        // is the missing boundary that previously made Step jump straight from
        // narration to a handoff (and made Attach wait for that handoff).
        const latestAssistant = [...sharedState.messages].reverse().find(
          message => message.role === 'assistant',
        );
        const completedModelTurn =
          !!latestAssistant
          && latestAssistant.id !== assistantMessageIdBeforeStep
          && latestAssistant.processNodeId === checkpointNodeId;
        // Only inspect calls produced by this model turn. Looking backwards for
        // the last assistant with calls would re-trigger an old tool breakpoint
        // when a later assistant turn contains only final narration.
        const producedToolCalls = latestAssistant?.tool_calls;
        const toolBreakpointName = matchedToolBreakpointName(producedToolCalls);
        const attachRequested = hasAttachRequest();

        if (
          currentAction !== ERROR_ACTION
          && completedModelTurn
          && (singleStep || attachRequested || !!toolBreakpointName)
        ) {
          const attached = attachRequested ? consumeAttachRequest() : false;
          const pendingCalls = currentAction === TOOL_CALL_ACTION ? producedToolCalls : undefined;

          // Without approvals, the next Step executes exactly this captured
          // batch and pauses after its results. With approvals enabled, retain
          // the action instead so resuming still passes through the permission /
          // approval gate rather than accidentally bypassing it.
          if (pendingCalls?.length && !requireApproval) {
            sharedState.debugPendingToolCalls = pendingCalls;
          } else {
            sharedState.debugPendingAction = {
              action: currentAction,
              nodeId: checkpointNodeId,
              phase: 'after-model',
            };
          }

          const isHandoffCall = producedToolCalls?.some(call =>
            call.type === 'function'
            && (
              call.function?.name === 'handoff'
              || call.function?.name?.startsWith('handoff_to_')
            ),
          );
          pauseForDebug({
            reason: attached || toolBreakpointName ? 'breakpoint' : 'debug',
            phase: isHandoffCall
              ? 'before-handoff'
              : pendingCalls?.length
                ? 'before-tool'
                : 'after-model',
            nodeId: checkpointNodeId,
            kind: attached ? 'attach' : toolBreakpointName ? 'tool' : undefined,
            ...(toolBreakpointName ? { toolName: toolBreakpointName } : {}),
          });
          FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
          try {
            sharedState.updatedAt = Date.now();
            await persistState(storageKey, sharedState);
          } catch (error) {
            log.error(`Failed to save state at post-model debug boundary for conv ${effectiveConvId}:`, error);
          }
          break;
        }
        }

        log.debug(`[Action Handling] Step ${internalIterations}: Received action "${currentAction}" for conv ${effectiveConvId}`);

        if (!currentAction) {
          sharedState.lastResponse = { success: false, error: 'Execution reached action handling without a node action.' };
          currentAction = ERROR_ACTION;
        }

        // 2b. Handle the action returned by the step
        if (currentAction === ERROR_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling ERROR_ACTION for conv ${effectiveConvId}`);
          log.error(`Error action received during step ${internalIterations} for conv ${effectiveConvId}`, { error: sharedState.lastResponse });
          break;
        }

        if (currentAction === FINAL_RESPONSE_ACTION) {
          log.info(`[Action Handling] Step ${internalIterations}: Handling FINAL_RESPONSE_ACTION for conv ${effectiveConvId}`);
          log.info(`Final response action received at step ${internalIterations} for conv ${effectiveConvId}`);

          // Graceful landing (issue #253): this FINAL_RESPONSE is the forced
          // text-only summary we requested when the turn budget was spent. Mark
          // the run `capped` (a success-like terminal state distinct from error,
          // so captureVariable/lastOutput chaining still fires on the summary)
          // and finish — do NOT drive forward or drain steering; the plane has
          // landed on purpose.
          if (sharedState.forceSummaryTurn) {
            sharedState.forceSummaryTurn = false;
            sharedState.capped = true;
            sharedState.status = 'capped';
            log.info(`[#253] Graceful landing complete for conv ${effectiveConvId}; status=capped.`);
            break;
          }

          // Unattended safety net (issue #218): a Process node that ended its
          // turn on plain text (no tool call / handoff) would silently complete
          // the run here. In unattended mode, drive it forward along its single
          // non-returning successor instead (or nudge on ambiguity), so a model
          // that "narrates and stops" can't dead-end the flow halfway. Returns
          // 'complete' for interactive runs, finish nodes, and genuine leaves —
          // preserving today's behavior for everything except the stall case.
          const driven = await unattendedDriveForward(sharedState, emit, unattendedNudges);
          if (driven === 'advanced') {
            emitNewMessages();
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            continue;
          }
          if (driven === 'nudged') {
            emitNewMessages();
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            continue;
          }

          // Mid-run steering, last call: a message posted while the model was
          // producing this final response would otherwise be stranded in the
          // inbox with the run already over. Fold it in and keep going — the
          // user asked the running agent something, so the running agent
          // answers it rather than making them re-send into a fresh turn.
          if (await drainSteering()) {
            log.info(`Steering message arrived as ${effectiveConvId} was completing; continuing the run to answer it.`);
            FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
            continue;
          }

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
              // --- Graceful landing at the agentic-turn cap (issue #253) ---
              // The R/R tool loop is where per-node maxTurns is actually enforced
              // (adapters ignore it — FLUJO drives the loop here). Count this
              // node's tool turns; once the budget is spent, DO NOT run more
              // tools — answer the pending calls synthetically and force one
              // final text-only summary turn so the run "lands the plane".
              const capNodeId = sharedState.currentNodeId;
              if (capNodeId && !sharedState.forceSummaryTurn) {
                const turns = (nodeTurnCounts.get(capNodeId) ?? 0) + 1;
                nodeTurnCounts.set(capNodeId, turns);
                const cap = sharedState.turnBudgets?.[capNodeId] ?? DEFAULT_AGENTIC_MAX_TURNS;
                if (turns >= cap) {
                  log.info(`[#253] Turn budget (${cap}) reached for node ${capNodeId} on conv ${effectiveConvId}; forcing a graceful summary turn instead of executing tools.`);
                  const nowTs = Date.now();
                  // Answer every still-pending tool call synthetically so the
                  // transcript stays well-formed (unanswered tool_calls 400).
                  const cappedToolResults: FlujoChatMessage[] = lastAssistantMsg.tool_calls.map((tc) => ({
                    id: crypto.randomUUID(),
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: GRACEFUL_CAP_TOOL_RESULT,
                    timestamp: nowTs,
                    processNodeId: capNodeId,
                  } as FlujoChatMessage));
                  const summaryInstruction: FlujoChatMessage = {
                    id: crypto.randomUUID(),
                    role: 'user',
                    content: GRACEFUL_CAP_SUMMARY_INSTRUCTION,
                    timestamp: nowTs + 1,
                    processNodeId: capNodeId,
                  } as FlujoChatMessage;
                  sharedState.messages.push(...cappedToolResults, summaryInstruction);
                  sharedState.forceSummaryTurn = true;
                  sharedState.cappedReason = 'maxTurns';
                  FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                  emitNewMessages();
                  if (!sharedState.ephemeral) {
                    try {
                      await appendRawForState(
                        sharedState,
                        [...cappedToolResults, summaryInstruction].map((m) => ({ type: 'message', message: m })),
                      );
                    } catch (err) {
                      log.warn(`Failed to append graceful-cap messages to log for ${effectiveConvId}`, err);
                    }
                  }
                  continue;
                }
              }
              // --- Flujo=true: Handle optional approval ---
              if (requireApproval) {
                // Issue #246: Before pausing, filter tool calls through the permission
                // rules. Calls with effect 'deny' or 'allow' are handled immediately;
                // only 'ask' calls are queued for the approval gate.
                const toolCallsForApproval: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
                const toolCallsToProcessNow: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
                const permRules = sharedState.permissionRules ?? [];
                const savedRules = sharedState.savedPermissionRules ?? [];

                if (permRules.length > 0 || savedRules.length > 0) {
                  for (const tc of lastAssistantMsg.tool_calls) {
                    // Meeting controls are local coordinator operations, not
                    // external side effects, so they never need a human
                    // approval prompt. All ordinary tools still follow the
                    // flow's permission rules below.
                    if (isMeetingToolName(tc.function.name)) {
                      toolCallsToProcessNow.push(tc);
                      continue;
                    }
                    const decoded = decodeToolName(tc.function.name, sharedState.toolNameMap);
                    if (!decoded) {
                      // Undecodable (handoff, synthetic) — pass through to approval
                      toolCallsForApproval.push(tc);
                      continue;
                    }
                    let callArgs: Record<string, unknown> = {};
                    try { callArgs = JSON.parse(tc.function.arguments); } catch { /* best effort */ }
                    const resource = extractResource(callArgs);
                    const effect = evaluatePermission(permRules, savedRules, decoded.server, decoded.tool, resource);
                    if (effect === 'deny' || effect === 'allow') {
                      toolCallsToProcessNow.push(tc);
                    } else {
                      toolCallsForApproval.push(tc);
                    }
                  }
                } else {
                  // With no explicit rules, only coordinator-owned meeting
                  // controls bypass the approval gate.
                  for (const tc of lastAssistantMsg.tool_calls) {
                    if (isMeetingToolName(tc.function.name)) toolCallsToProcessNow.push(tc);
                    else toolCallsForApproval.push(tc);
                  }
                }

                if (
                  sharedState.onApprovalRequired === 'fail'
                  && toolCallsForApproval.length > 0
                ) {
                  // Headless fail-fast (#115): at least one call still needs a
                  // human decision after permission evaluation. Execute
                  // nothing from this batch and return a structured error.
                  const firstCall = toolCallsForApproval[0];
                  const toolName = firstCall?.function.name ?? 'unknown';
                  log.info(`[flujo=true, onApprovalRequired=fail] Failing fast for tool "${toolName}" (conv ${effectiveConvId})`);
                  sharedState.status = 'error';
                  sharedState.pendingToolCalls = toolCallsForApproval;
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

                // Process immediately-resolved (allow/deny) calls
                if (toolCallsToProcessNow.length > 0) {
                  const immediateResult = await processToolCallsRecoverably({
                    toolCalls: toolCallsToProcessNow,
                    toolNameMap: sharedState.toolNameMap,
                    emit,
                    conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
                    runId: logicalRunId,
                    node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
                    shouldAbort: runCancelled,
                    mcpNodes: sharedState.currentMCPNodes,
                    permissionRules: permRules,
                    savedPermissionRules: savedRules,
                    unattended: sharedState.unattended, // Issue #258
                  });
                  if (immediateResult.success) {
                    const immediateMessages = immediateResult.value.toolCallMessages.map(msg => ({
                      ...msg,
                      id: crypto.randomUUID(),
                      timestamp: Date.now(),
                      processNodeId: sharedState.currentNodeId,
                    }));
                    sharedState.messages.push(...immediateMessages);
                    emitNewMessages();
                    await commitToolCheckpoint(storageKey, sharedState, toolCallsToProcessNow, 'completed', recoveryEmit);
                  }
                }

                // If no calls need approval, continue the loop
                if (toolCallsForApproval.length === 0) {
                  FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                  const attachedAfterTool = await pauseForAttachAtSafePoint('after-tool');
                  if (singleStep && !attachedAfterTool) {
                    pauseForDebug({ phase: 'after-tool' });
                  }
                  if (singleStep || attachedAfterTool) break;
                  continue;
                }

                log.info(`[flujo=true, requireApproval=true] Pausing execution for tool approval for conv ${effectiveConvId}`);
                sharedState.status = 'awaiting_tool_approval';
                sharedState.pendingToolCalls = toolCallsForApproval;
                sharedState.lastResponse = undefined;
                FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
                try {
                  sharedState.updatedAt = Date.now();
                  if (isDefaultConversationTitle(sharedState.title) && sharedState.messages.length > 0) {
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
              } else {
                log.info(`[flujo=true, requireApproval=false] Processing ${lastAssistantMsg.tool_calls.length} tools internally for conv ${effectiveConvId}`);
                const toolProcessingResult = await processToolCallsRecoverably({
                  toolCalls: lastAssistantMsg.tool_calls, toolNameMap: sharedState.toolNameMap, emit,
                  conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
                  runId: logicalRunId,
                  node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
                  shouldAbort: runCancelled,
                  mcpNodes: sharedState.currentMCPNodes, // Issue #239: native resource tools
                  permissionRules: sharedState.permissionRules, // Issue #246
                  savedPermissionRules: sharedState.savedPermissionRules, // Issue #246
                  unattended: sharedState.unattended, // Issue #258
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
                await commitToolCheckpoint(storageKey, sharedState, lastAssistantMsg.tool_calls, 'completed', recoveryEmit);
                const attachedAfterTool = await pauseForAttachAtSafePoint('after-tool');
                if (attachedAfterTool) break;
                log.info(`Continuing loop for conv ${effectiveConvId} after internal tool processing (no approval needed).`);
                continue;
              }
            } else {
              // --- flujo=false: Handle internal vs external tools ---
              log.info(`[flujo=false] Tool call action received for conv ${effectiveConvId}. Checking tool types.`);
              const allToolCalls = requireFunctionToolCalls(lastAssistantMsg.tool_calls);
              const internalTools: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];
              const externalTools: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];

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
                const toolProcessingResult = await processToolCallsRecoverably({
                  toolCalls: internalTools, toolNameMap: sharedState.toolNameMap, emit,
                  conversationId: sharedState.ephemeral ? undefined : sharedState.conversationId,
                  runId: logicalRunId,
                  node: sharedState.currentNodeId ? { nodeId: sharedState.currentNodeId } : undefined,
                  shouldAbort: runCancelled,
                  mcpNodes: sharedState.currentMCPNodes, // Issue #239: native resource tools
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
                emitNewMessages();
                await commitToolCheckpoint(storageKey, sharedState, internalTools, 'completed', recoveryEmit);
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

            // Reset any caller handoff input at the transition: it is single-shot
            // and scoped to exactly ONE target node. The block below re-sets it
            // for `nextNodeId` when this handoff carries caller args. Clearing it
            // here (rather than relying on the target's prep to consume it) keeps
            // it from leaking to a later node or a REVISIT of the same node — a
            // process node reads it WITHOUT clearing (its tool loop re-runs prep
            // each iteration), so its lifecycle is managed here instead.
            sharedState.handoffInput = undefined;

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
              let signalBody = '';
              let callerFlows: string[] | undefined;
              let callerConcurrency: number | undefined;
              const isSubflowHandoff = sharedState.handoffTargetTypes?.[nextNodeId] === 'subflow';
              callsToAnswer.forEach((call, laneIdx) => {
                if (call.type === 'function') {
                  try {
                    const parsedArgs = JSON.parse(call.function.arguments || '{}');
                    const task = typeof parsedArgs?.task === 'string' ? parsedArgs.task.trim() : '';
                    const prompt = typeof parsedArgs?.prompt === 'string' ? parsedArgs.prompt.trim() : '';
                    const body = typeof parsedArgs?.body === 'string' ? parsedArgs.body.trim() : '';
                    if (!signalBody && body) signalBody = body;
                    // `task` is always a spawn brief; a `prompt` on a MULTI-call
                    // turn clearly means per-instance instructions too. On a
                    // single-call turn `prompt` keeps its issue-#96 meaning.
                    const brief = task || (callsToAnswer.length > 1 ? prompt : '');
                    // Every Subflow handoff call is one queued job, even when it
                    // omits `task` and therefore uses the node's configured input.
                    // Other target types retain the old non-empty-only behavior.
                    if (isSubflowHandoff || brief) briefs.push(brief);
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
              const isSignalHandoff = sharedState.handoffTargetTypes?.[nextNodeId] === 'signal';
              if (isSignalHandoff || signalBody || callerPrompt || briefs.length > 0 || (callerFlows && callerFlows.length > 0)) {
                sharedState.handoffInput = {
                  targetNodeId: nextNodeId,
                  prompt: callerPrompt,
                  ...(isSignalHandoff ? { fromHandoffTool: true } : {}),
                  ...(signalBody ? { signalBody } : {}),
                  ...(briefs.length > 0 ? { tasks: briefs } : {}),
                  ...(callerFlows && callerFlows.length > 0 ? { parallelFlows: callerFlows } : {}),
                  ...(callerConcurrency !== undefined ? { concurrencyLimit: callerConcurrency } : {}),
                };
                log.info(`Captured caller handoff input for node ${nextNodeId}`, {
                  promptChars: callerPrompt.length,
                  signalBodyChars: signalBody.length,
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
                  const targetProps = targetNode?.data?.properties as { inputMode?: string; allowCallerPrompt?: boolean; allowCallerFanout?: boolean; promptTemplate?: string; isolatedPrompt?: string } | undefined;
                  // The target's authored isolated message: promptTemplate for a
                  // subflow, isolatedPrompt for a process node (issue #96).
                  const authoredIsolated =
                    targetNode?.type === 'subflow' ? targetProps?.promptTemplate : targetProps?.isolatedPrompt;
                  if (
                    (targetNode?.type === 'subflow' || targetNode?.type === 'process') &&
                    targetProps?.inputMode === 'isolated' &&
                    targetProps?.allowCallerPrompt !== false &&
                    targetProps?.allowCallerFanout !== true &&
                    !(authoredIsolated?.trim())
                  ) {
                    log.warn(
                      `Handoff to isolated ${targetNode?.type} node ${nextNodeId} has neither a caller-supplied prompt nor an authored message; the target will start with an empty prompt and may stall. The routing model should have supplied the required "prompt" argument (issue #169).`,
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
            // The engine marks only Process -> one-way TERMINAL Subflow calls.
            // Sequential Subflows and explicit bidirectional edges omit this,
            // and every later transition clears any previous marker.
            sharedState.pendingSubflowReturn = handoff.implicitSubflowReturn;
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
      // Issue #383 (gap 1): this loop-level catch previously set lastResponse
      // but never emitted an `error` event, so a failure caught here (as
      // opposed to inside FlowExecutor.executeStep) was silent on a live run.
      emitErrorOnce(sharedState, emit, loopError, {
        nodeId: sharedState.currentNodeId,
      });
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

  // Issue #383 (gap 1) backstop: guarantee that EVERY run ending in 'error'
  // produces at least one `error` event, even if none of the specific emit
  // sites above happened to fire for this particular failure shape. Skipped
  // for user cancellation (`isCancelled`) — a stop is not an error and must
  // keep rendering as the neutral "stopped" banner.
  if (
    currentAction === ERROR_ACTION
    && !sharedState.errorEventEmitted
    && !sharedState.isCancelled
  ) {
    const derived = deriveLastErrorFromLastResponse(sharedState.lastResponse);
    if (derived) {
      emitNormalizedErrorOnce(sharedState, emit, derived, { nodeId: sharedState.currentNodeId });
    }
  }

  // --- 3. Finalize ---
  // Clear elicitation context for all MCP servers bound in this run.
  for (const serverName of elicitationServerNames) {
    clearElicitationContext(serverName);
  }

  const finalExecutionTime = Date.now() - startTime;
  const finalStatus = sharedState.status || (currentAction === FINAL_RESPONSE_ACTION ? 'completed' : (currentAction === ERROR_ACTION ? 'error' : 'running'));
  log.info(`Execution finished for conv ${effectiveConvId}. Final Action: ${currentAction}, Final Status: ${finalStatus}`, { duration: `${finalExecutionTime}ms` });

  // Debugging is run-scoped. Once this run is terminal, do not leave a hidden
  // debugMode/breakpoint payload attached to the conversation for its next user
  // turn (or paint the sidebar as though an old debug session were still live).
  if (finalStatus === 'completed' || finalStatus === 'error' || finalStatus === 'capped') {
    sharedState.debugMode = false;
    sharedState.debugPauseRequested = false;
    sharedState.debugPendingAction = undefined;
    sharedState.debugPendingToolCalls = undefined;
    sharedState.breakpoints = [];
    sharedState.lastBreakNodeId = undefined;
  }

  // Persist the precise recovery transition before the legacy terminal event.
  // Existing status values remain unchanged for backward compatibility.
  if (sharedState.isCancelled) {
    await commitRecoveryTransition(storageKey, sharedState, 'cancelled', {
      failure: {
        category: cancelledByAncestor ? 'ancestor_cancelled' : 'user_cancelled',
        message: cancelledByAncestor
          ? 'Execution was cancelled because an ancestor run was cancelled.'
          : 'Execution was cancelled by the user.',
        retryable: false,
      },
      cancellationRequestedAt: sharedState.recovery?.cancellationRequestedAt ?? Date.now(),
    }, recoveryEmit);
  } else if (finalStatus === 'completed') {
    await commitRecoveryTransition(storageKey, sharedState, 'completed', {}, recoveryEmit);
  } else if (finalStatus === 'capped') {
    await commitRecoveryTransition(storageKey, sharedState, 'capped', {}, recoveryEmit);
  } else if (finalStatus === 'awaiting_tool_approval' || finalStatus === 'paused_debug') {
    await commitRecoveryTransition(storageKey, sharedState, 'paused', {}, recoveryEmit);
  } else if (finalStatus === 'error') {
    const classified = classifyRecoveryFailure(sharedState.lastResponse);
    await commitRecoveryTransition(storageKey, sharedState, classified.classification, {
      failure: classified.failure,
      retryAfterAt: classified.retryAfterAt,
      manualActionRequired: classified.failure.category === 'tool_failure'
        ? true
        : sharedState.recovery?.manualActionRequired,
    }, recoveryEmit);
  }

  // Flush any trailing messages and signal terminal completion to live consumers.
  emitNewMessages();
  if (finalStatus === 'completed' || finalStatus === 'error' || finalStatus === 'capped') {
    emit({
      type: 'run:done',
      status: finalStatus,
      ...(finalStatus === 'error' && sharedState.lastError ? { error: sharedState.lastError } : {}),
    });
    // Flow-run event bus (issue #116): announce terminal runs so `flow-event`
    // triggers can react to chat/API/manual runs. Scheduler-fired runs are
    // announced by SchedulerService.fire() instead (de-dup), and subflow stages
    // (runDepth > 0) must NOT emit or a composed flow sprays one event per stage.
    if (
      sharedState.source !== 'schedule' &&
      sharedState.source !== 'trigger' &&
      sharedState.source !== 'meeting' &&
      (sharedState.runDepth ?? 0) === 0
    ) {
      const lastMsg = sharedState.messages[sharedState.messages.length - 1];
      const outputText =
        lastMsg && lastMsg.role === 'assistant' && typeof lastMsg.content === 'string'
          ? lastMsg.content
          : undefined;
      // A capped run is a successful terminal run for flow-event/chaining
      // purposes (issue #253): the summary IS the output, so report it as
      // 'completed' to the flow-run bus.
      void publishRunFlowEvent(sharedState, finalStatus === 'capped' ? 'completed' : finalStatus, outputText);
    }
  }

  let finalSnapshotPersisted = false;
  try {
    sharedState.updatedAt = Date.now();
    if (isDefaultConversationTitle(sharedState.title) && sharedState.messages.length > 0) {
      const firstUserMessage = sharedState.messages.find(m => m.role === 'user');
      if (firstUserMessage && typeof firstUserMessage.content === 'string') {
        sharedState.title = buildConversationTitle(firstUserMessage.content);
        log.verbose(`Updated conversation title for ${effectiveConvId} before final return to: ${sharedState.title}`);
      }
    }
    await persistState(storageKey, sharedState); // chokepoint refuses ephemeral + deleted states
    finalSnapshotPersisted = true;
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
    forgetConversationCacheEntry(effectiveConvId);
  } else {
    FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
    noteConversationWrite(effectiveConvId, sharedState);
  }

  // --- Run-owned resource release + bounded conversation memory (issue #413) ---
  // A terminal run must not leave anything of its own alive. Two distinct leaks
  // were fixed here:
  //  1. Bash background/PTY sessions the run started stayed alive for the
  //     process lifetime, because nothing ever told the Bash server the owning
  //     run had ended. `release_owner` kills the run's non-detached sessions and
  //     their descendant trees; a session explicitly started `detached` survives
  //     on purpose.
  //  2. The conversation stayed in the global state map forever. Marking it
  //     terminal makes it evictable ONLY after its durable snapshot exists, so a
  //     later resume/inspect transparently reloads it from storage.
  // Both are best-effort and deliberately not awaited: neither may delay or fail
  // the run's result.
  const terminalStatus =
    sharedState.status === 'completed' ||
    sharedState.status === 'error' ||
    sharedState.status === 'capped';
  if (terminalStatus) {
    const runOwnerScope = ownerScopeForRun({
      runId: sharedState.logicalRunId,
      conversationId: sharedState.conversationId || effectiveConvId,
    });
    void releaseRunOwnedBashSessions(runOwnerScope);
    if (!isConversationDeleted(effectiveConvId) && !ephemeral) {
      void markConversationTerminal(effectiveConvId, sharedState, async () => {
        // The snapshot above already succeeded in the normal case; only retry it
        // when that write failed, so persist-before-evict still holds.
        if (!finalSnapshotPersisted) await persistState(storageKey, sharedState);
      });
    }
  }

  // An ephemeral run is transient: drop it from the in-memory map once it
  // reaches a terminal state so isolated/subflow runs don't accumulate.
  const cleanupEphemeral = () => {
    if (ephemeral && (sharedState.status === 'completed' || sharedState.status === 'error')) {
      FlowExecutor.conversationStates.delete(effectiveConvId);
      forgetConversationCacheEntry(effectiveConvId);
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
    return finalizeRun({
      ...baseResult,
      status: 'paused_debug',
      outputText: '',
      pendingToolCalls: sharedState.pendingToolCalls,
    });
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
    return finalizeRun({
      ...baseResult,
      status: 'error',
      outputText: '',
      error: { message: errorMessage, details: errorDetails, statusCode },
    });
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

  // A child flow may generate media and then finish with a text-only process or
  // handoff message. Returning media only from the literal last message drops
  // those artifacts at the subflow boundary, so SubflowNode never gets a chance
  // to promote them into the parent run. Preserve the most recent assistant
  // artifact set instead; this also naturally prefers a later replacement over
  // an earlier draft without returning every historical attachment.
  let outputMedia: ModelMediaPart[] | undefined;
  for (let i = sharedState.messages.length - 1; i >= 0; i--) {
    const message = sharedState.messages[i];
    if (message.role === 'assistant' && message.media?.length) {
      outputMedia = message.media;
      break;
    }
  }

  log.info(`Returning success result for conv ${effectiveConvId}`, { action: currentAction, status: sharedState.status, flujo, requireApproval, flujodebug });

  cleanupEphemeral();
  return finalizeRun({
    ...baseResult,
    status: (sharedState.status as FlowRunStatus) || (currentAction === FINAL_RESPONSE_ACTION ? 'completed' : 'running'),
    outputText: responseContent,
    ...(outputMedia ? { outputMedia } : {}),
    toolCalls,
    pendingToolCalls: sharedState.pendingToolCalls,
  });
}
