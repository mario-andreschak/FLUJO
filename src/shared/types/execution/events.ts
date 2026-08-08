import OpenAI from 'openai';
import { FlujoChatMessage } from '@/shared/types/chat';
import type { NormalizedChatError } from '@/shared/types/execution/errors';

/** Additive, durable recovery semantics. Existing SharedState.status values stay
 * unchanged so older snapshots and clients remain readable. */
export type RecoveryClassification =
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'retryable_failure'
  | 'permanent_failure'
  | 'capped';

export type RecoveryFailureCategory =
  | 'user_cancelled'
  | 'ancestor_cancelled'
  | 'transport_failure'
  | 'provider_failure'
  | 'rate_limit'
  | 'context_limit'
  | 'input_limit'
  | 'session_loss'
  | 'model_empty_response'
  | 'model_truncated_response'
  | 'tool_failure'
  | 'unclean_process_interruption'
  | 'unknown';

export interface RecoveryLaneIdentity {
  laneIndex: number;
  laneCount?: number;
  laneTitle?: string;
  conversationId?: string;
  /** Durable Subflow-node visit that owns this lane. Unlike parentRunId, this
   *  distinguishes two separate visits to the same node in one parent run. */
  invocationId?: string;
  /** Stable lane id inside invocationId. The child keeps this across retries so
   *  a later successful continuation can satisfy the original parent join. */
  laneId?: string;
  /** Parent Subflow node parked at the join. */
  parentNodeId?: string;
}

export type RecoveryCheckpointPhase =
  | 'node:before'
  | 'node:after'
  | 'tool:before'
  | 'tool:after'
  | 'tool:unknown';

export interface RecoveryToolEffect {
  toolCallId: string;
  name: string;
  readOnly: boolean;
  idempotent: boolean;
  destructive?: boolean;
}

export interface RecoveryCheckpointRef {
  id: string;
  phase: RecoveryCheckpointPhase;
  nodeId?: string;
  turnEntryNodeId?: string;
  attempt: number;
  inputFingerprint: string;
  safe: boolean;
  effectStatus: 'none' | 'pending' | 'completed' | 'unknown';
  parentRunId?: string;
  lane?: RecoveryLaneIdentity;
  tools?: RecoveryToolEffect[];
  createdAt: number;
}

export interface RecoveryFailureDetails {
  category: RecoveryFailureCategory;
  message: string;
  code?: string;
  status?: number;
  retryable: boolean;
}

/** Version 1 recovery record persisted additively on SharedState. */
export interface RecoveryRecord {
  version: 1;
  runId: string;
  attemptId: string;
  attempt: number;
  classification: RecoveryClassification;
  failure?: RecoveryFailureDetails;
  retryAfterAt?: number;
  parentRunId?: string;
  lane?: RecoveryLaneIdentity;
  currentCheckpoint?: RecoveryCheckpointRef;
  lastSafeCheckpoint?: RecoveryCheckpointRef;
  ownerId?: string;
  ownerHeartbeatAt?: number;
  startedAt: number;
  updatedAt: number;
  terminalAt?: number;
  cancellationRequestedAt?: number;
  manualActionRequired?: boolean;
  sideEffectWarning?: string;
}

/**
 * Execution events emitted by the flow engine during a run.
 *
 * These are a *live projection* of what the executor is doing. The persisted
 * SharedState remains the source of truth for resume/reconnect; events carry
 * an authoritative, durable, monotonic `seq` per conversation (allocated by the
 * conversation log, issue #261) so consumers can order, dedupe, and resume from
 * a known position across runs and restarts (see conversationLog.allocateSeq).
 */
export type ExecutionEventType =
  | 'run:start'
  | 'run:paused'
  | 'run:awaiting_approval'
  | 'run:awaiting_elicitation'
  | 'run:awaiting_question'
  | 'run:done'
  | 'recovery:checkpoint'
  | 'recovery:transition'
  | 'recovery:retry'
  | 'node:enter'
  | 'node:exit'
  | 'node:snapshot'
  | 'node:changed-files'
  | 'model:start'
  | 'model:delta'
  | 'model:end'
  | 'tool:call'
  | 'tool:progress'
  | 'tool:result'
  | 'handoff'
  | 'usage'
  | 'message'
  | 'message:removed'
  | 'subflow:start'
  | 'subflow:done'
  | 'resource:read'
  | 'resource:write'
  | 'todo:update'
  | 'breakpoint:hit'
  | 'error';

export interface NodeRef {
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
}

export interface ExecutionEventBase {
  conversationId: string;
  seq: number;       // authoritative durable monotonic per conversation; the
                     // log allocates it (issue #261), the bus stamps it at emit
  timestamp: number; // ms since epoch, assigned by the bus
  type: ExecutionEventType;
  /**
   * Subflow nesting depth of the run that produced this event. Absent/0 for the
   * top-level conversation; a subflow child's events are forwarded onto the
   * PARENT's channel with depth = parent depth + 1 (each SubflowNode wrapper
   * adds one), so the live stream and the persisted conversation log can nest
   * child steps inside the parent conversation.
   */
  depth?: number;
  /**
   * Fan-out lane identity (issue #102). When a SubflowNode runs several child
   * flows CONCURRENTLY, each lane's forwarded events carry its 0-based
   * `laneIndex` and the total `laneCount`, so live-view / log consumers can keep
   * the interleaved lanes separable. Absent for single-child subflows and
   * top-level runs (so existing single-lane behavior is unchanged).
   */
  laneIndex?: number;
  laneCount?: number;
}

export interface RunStartEvent extends ExecutionEventBase {
  type: 'run:start';
  flowId: string;
}
export interface RunPausedEvent extends ExecutionEventBase {
  type: 'run:paused';
  reason: 'debug' | 'breakpoint';
  node?: NodeRef;
  /** Stable runtime boundary at which execution was parked. */
  phase?: 'before-node' | 'after-model' | 'before-tool' | 'after-tool' | 'before-handoff';
  /** Model-facing tool name when a tool breakpoint caused the pause. */
  toolName?: string;
}
export interface RunAwaitingApprovalEvent extends ExecutionEventBase {
  type: 'run:awaiting_approval';
  pendingToolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[];
}
export interface RunAwaitingElicitationEvent extends ExecutionEventBase {
  type: 'run:awaiting_elicitation';
  /** Stable ID for correlating the SSE event to the /respond route call. */
  elicitationId: string;
  /** Human-readable prompt from the server. */
  message: string;
  /** JSON Schema object subset describing the fields to collect. */
  requestedSchema: Record<string, unknown>;
}
/** One prompt of a model-initiated `question` tool call (issue #258). */
export interface QuestionPrompt {
  /** The question text shown to the user. */
  prompt: string;
  /** The offered options (already including any auto-appended free-text option). */
  options: string[];
  /** Whether more than one option may be selected. */
  multiple?: boolean;
  /** Whether a free-text "Type your own answer" option is offered. */
  custom?: boolean;
}
/**
 * A model asked the user a structured multiple-choice question mid-run via the
 * synthetic `question` tool and the turn is BLOCKED awaiting the answer
 * (issue #258). The frontend renders a QuestionCard and answers/declines via
 * the `/respond` route; the headless approvals API can answer too.
 */
export interface RunAwaitingQuestionEvent extends ExecutionEventBase {
  type: 'run:awaiting_question';
  node?: NodeRef;
  /** Stable ID for correlating the SSE event to the /respond route call. */
  questionId: string;
  /** The questions to ask, in order. */
  questions: QuestionPrompt[];
}
export interface RunDoneEvent extends ExecutionEventBase {
  type: 'run:done';
  // 'capped' (issue #253): the run landed gracefully at a Process node's
  // agentic-turn budget with a forced text-only summary — a success-like
  // terminal state, distinct from 'error', so the UI can show it differently.
  status: 'completed' | 'error' | 'capped';
  /** Issue #383: normalized terminal error, set when status === 'error' so a
   *  client that missed the mid-stream `error` event still learns why. */
  error?: NormalizedChatError;
}
export interface RecoveryCheckpointEvent extends ExecutionEventBase {
  type: 'recovery:checkpoint';
  checkpoint: RecoveryCheckpointRef;
}
export interface RecoveryTransitionEvent extends ExecutionEventBase {
  type: 'recovery:transition';
  recovery: RecoveryRecord;
}
/**
 * The run hit a bounded, replayable provider limit and is WAITING before it
 * retries the same call (issue #400). It is not a terminal event: the run stays
 * alive and cancellable, and a later `run:done`/`error` (or simply further
 * progress) supersedes it.
 *
 * Only sanitized timing/classification metadata is carried — never provider
 * bodies, headers beyond the parsed delay, credentials, or prompt content.
 */
export interface RecoveryRetryEvent extends ExecutionEventBase {
  type: 'recovery:retry';
  /** 1-based number of the attempt that will run once the wait elapses. */
  attempt: number;
  /** Absolute deadline (ms since epoch, server clock) of the wait. */
  retryAt: number;
  failure: RecoveryFailureDetails;
  /** Total attempts this run may make, so the UI can show "2 of 4". */
  maxAttempts?: number;
  /** Node that owns the waiting model call, when known. */
  node?: NodeRef;
}
export interface NodeEnterEvent extends ExecutionEventBase {
  type: 'node:enter';
  node: NodeRef;
}
export interface NodeExitEvent extends ExecutionEventBase {
  type: 'node:exit';
  node: NodeRef;
  action: string;
}
/** One changed path in a filesystem snapshot diff (issue #250). */
export interface SnapshotChangedFile {
  /** Repo-relative POSIX path. */
  path: string;
  /** git name-status code: A/M/D/R… */
  status: string;
}
/**
 * A filesystem snapshot of a confinement root was taken before/after a Process
 * node that had a snapshot-capable host-path server armed (issue #250).
 * `snapshotId` is the shadow-repo commit SHA; `root` is the captured root.
 */
export interface NodeSnapshotEvent extends ExecutionEventBase {
  type: 'node:snapshot';
  node?: NodeRef;
  phase: 'before' | 'after';
  root: string;
  snapshotId: string;
}
/**
 * The set of files a Process node changed within a confinement root, computed
 * from the diff between its before/after snapshots (issue #250). Powers the
 * per-node changed-file view and the "Revert to here" action.
 */
export interface NodeChangedFilesEvent extends ExecutionEventBase {
  type: 'node:changed-files';
  node?: NodeRef;
  root: string;
  startSnapshot: string;
  endSnapshot: string;
  changedFiles: SnapshotChangedFile[];
  /** Persisted unified patch for this root, when storage caps allowed it. */
  patchResourceUri?: string;
}
export interface ModelStartEvent extends ExecutionEventBase {
  type: 'model:start';
  node?: NodeRef;
  model?: string;
}
export interface ModelDeltaEvent extends ExecutionEventBase {
  type: 'model:delta';
  node?: NodeRef;
  /** Stable assistant-message id shared with the final durable message. */
  messageId: string;
  /** Append-only assistant text delta. */
  delta?: string;
  /** Complete provider-neutral media item produced during the stream. */
  mediaPart?: import('@/shared/types/model/media').ModelMediaPart;
  /** Append-only function-call metadata/argument delta. */
  toolCallDelta?: {
    index: number;
    id?: string;
    nameDelta?: string;
    argumentsDelta?: string;
  };
}
export interface ModelEndEvent extends ExecutionEventBase {
  type: 'model:end';
  node?: NodeRef;
  content?: string;
  /** Draft to finalize or discard after an interrupted/failed stream. */
  messageId?: string;
  discard?: boolean;
}
export interface ToolCallEvent extends ExecutionEventBase {
  type: 'tool:call';
  node?: NodeRef;
  toolCallId: string;
  name: string;
  args?: string;
}
/**
 * A server-side progress notification for a running MCP tool call (MCP
 * `notifications/progress`, forwarded by the SDK). Live-only, like model:delta:
 * it keeps the UI's stall detector fed during long tool calls and is never
 * persisted to the conversation log.
 */
export interface ToolProgressEvent extends ExecutionEventBase {
  type: 'tool:progress';
  node?: NodeRef;
  toolCallId: string;
  name: string;
  progress: number;
  total?: number;
  message?: string;
}
export interface ToolResultEvent extends ExecutionEventBase {
  type: 'tool:result';
  node?: NodeRef;
  toolCallId: string;
  name: string;
  result?: string;
  isError?: boolean;
}
export interface HandoffEvent extends ExecutionEventBase {
  type: 'handoff';
  from?: NodeRef;
  toNodeId: string;
  edgeId?: string;
}
export interface UsageEvent extends ExecutionEventBase {
  type: 'usage';
  node?: NodeRef;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
  /** Subset of promptTokens re-read cheaply from the provider prompt cache (#87). */
  cacheReadTokens?: number;
  /** Subset of promptTokens written to the provider prompt cache. */
  cacheWriteTokens?: number;
}
/** A new message was appended to the conversation (assistant, tool result, etc.). */
export interface MessageEvent extends ExecutionEventBase {
  type: 'message';
  node?: NodeRef;
  message: FlujoChatMessage;
}
/**
 * A message was removed from the conversation (the chat client sends the full,
 * possibly pruned, history each turn — see runFlow's turn-start reconcile).
 * Log-only: written straight to the conversation log (with a freshly allocated
 * authoritative seq, issue #261), never emitted on the live bus.
 */
export interface MessageRemovedEvent extends ExecutionEventBase {
  type: 'message:removed';
  messageId: string;
}
/** A SubflowNode started its child run (child events follow with depth+1). */
export interface SubflowStartEvent extends ExecutionEventBase {
  type: 'subflow:start';
  node?: NodeRef;
  subflowId: string;
  subflowName?: string;
  /** The lane's brief / map item title (falls back to the subflow name for
   *  static fan-out lanes) — labels the lane's live-view row (issue #157).
   *  Carried on subflow:done too so a late-joining client that missed start
   *  still gets label + link. */
  laneTitle?: string;
  /** The lane's persisted sidebar conversation (present only when
   *  saveConversation is on) — lets the live view deep-link into the lane. */
  laneConversationId?: string;
}
/** The child run of a SubflowNode reached a terminal state. */
export interface SubflowDoneEvent extends ExecutionEventBase {
  type: 'subflow:done';
  node?: NodeRef;
  subflowId: string;
  status: 'completed' | 'error' | 'capped';
  /** See SubflowStartEvent — duplicated here for late-joining clients. */
  laneTitle?: string;
  laneConversationId?: string;
}
/**
 * A resource was read during execution. `source` says through which mechanism:
 * a `${resource:...}` prompt pill, a `${res:NAME}` run-resource reference, a
 * consume-edge resource NODE (in which case `node` is the resource node so the
 * canvas can light it up), or an MCP resources/read served by the internal
 * "flujo" server.
 */
export interface ResourceReadEvent extends ExecutionEventBase {
  type: 'resource:read';
  node?: NodeRef;
  server: string;
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
  source: 'pill' | 'res-ref' | 'node' | 'mcp-read' | 'tool-read';
}
/**
 * A resource was written to the run-scoped store: a tool result auto-captured
 * (`tool-result`, carries the producing `toolCallId` — stable across runFlow's
 * tool-message id rewrite), a node's `captureResource` output (`capture`), or
 * an MCP-app write (`mcp-app`, reserved), or oversized tool-call PARAMETERS
 * captured for later dereference (`tool-args`, carries the producing
 * `toolCallId` — issue #168).
 */
export interface ResourceWriteEvent extends ExecutionEventBase {
  type: 'resource:write';
  node?: NodeRef;
  server: string;
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
  source: 'tool-result' | 'capture' | 'mcp-app' | 'tool-args' | 'snapshot';
  toolCallId?: string;
  /** Snapshot metadata used by the first-party DevCanvas diff view. */
  snapshot?: {
    root: string;
    startSnapshot: string;
    endSnapshot: string;
    changedFiles: SnapshotChangedFile[];
  };
}
export interface BreakpointHitEvent extends ExecutionEventBase {
  type: 'breakpoint:hit';
  node: NodeRef;
  kind?: 'node' | 'tool' | 'attach';
  toolName?: string;
}
/** One task in a `todo:update` event (issue #259) — mirrors SharedState.todos. */
export interface TodoEventItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}
/**
 * The run-scoped `todo` list was created/updated by a model via the synthetic
 * `todo` tool (issue #259). Carries the FULL current list (not a delta) so a
 * late-joining / replaying client rebuilds the checklist from the bus ring
 * buffer. Live-view only; the authoritative copy lives on SharedState.todos.
 */
export interface TodoUpdateEvent extends ExecutionEventBase {
  type: 'todo:update';
  node?: NodeRef;
  todos: TodoEventItem[];
}
export interface ErrorEvent extends ExecutionEventBase {
  type: 'error';
  node?: NodeRef;
  message: string;
  /** Issue #383: normalized error detail (code/status/class/redacted body). */
  error?: NormalizedChatError;
}

export type ExecutionEvent =
  | RunStartEvent
  | RunPausedEvent
  | RunAwaitingApprovalEvent
  | RunAwaitingElicitationEvent
  | RunAwaitingQuestionEvent
  | RunDoneEvent
  | RecoveryCheckpointEvent
  | RecoveryTransitionEvent
  | RecoveryRetryEvent
  | NodeEnterEvent
  | NodeExitEvent
  | NodeSnapshotEvent
  | NodeChangedFilesEvent
  | ModelStartEvent
  | ModelDeltaEvent
  | ModelEndEvent
  | ToolCallEvent
  | ToolProgressEvent
  | ToolResultEvent
  | HandoffEvent
  | UsageEvent
  | MessageEvent
  | MessageRemovedEvent
  | SubflowStartEvent
  | SubflowDoneEvent
  | ResourceReadEvent
  | ResourceWriteEvent
  | TodoUpdateEvent
  | BreakpointHitEvent
  | ErrorEvent;

/** Distributes Omit across a union so the discriminant is preserved. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * What callers pass to emit(): the bus fills in conversationId, seq and
 * timestamp, so producers only describe *what* happened.
 */
export type RawExecutionEvent = DistributiveOmit<ExecutionEvent, 'conversationId' | 'seq' | 'timestamp'>;

/** Emit callback handed to the engine/nodes; bound to a conversation by the caller. */
export type EmitFn = (event: RawExecutionEvent) => void;

/** Aggregated token/cost accounting kept on SharedState. */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /**
   * Sum of the cache RE-READ tokens across the conversation (subset of
   * promptTokens). Optional: absent on state persisted before #87. Lets the UI
   * show the honest "fresh (+cached)" split.
   */
  cacheReadTokens?: number;
  /** Sum of prompt tokens written to provider caches. */
  cacheWriteTokens?: number;
  byNode: Record<string, {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }>;
}
