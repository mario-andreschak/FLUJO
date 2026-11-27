// What runFlow accepts and returns. Callers may import these types from here
// or from runFlow.ts, which re-exports them.
import type { FlowDecision } from '@/utils/shared/decisionRules';
import type { FlowReplayInputs } from '@/shared/types/execution/flowInputs';
import type { EmitFn, RecoveryLaneIdentity, UsageTotals } from '@/shared/types/execution/events';
import type OpenAI from 'openai';
import type { SharedState, FlowInvocationSource, ErrorDetails } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ModelMediaPart } from '@/shared/types/model/media';
import type { Flow } from '@/shared/types/flow';
import type { PersonaAttribution, PersonaInstructionContext } from '@/shared/types/enduringAgent';

export type FlowRunStatus = 'completed' | 'error' | 'awaiting_tool_approval' | 'paused_debug' | 'running' | 'capped';

/**
 * The "flow-as-callable" keystone input. One operation — run a flow with a
 * defined input → defined output, in isolated state — shared by the
 * OpenAI-compatible API (today), subflows (#13), planned executions (#10), and
 * (deferred) flows-as-MCP-tools (#17B).
 */
export interface FlowRunInput extends FlowReplayInputs {
  executionExtensionContext?: import('@/backend/execution/extensions').ExecutionExtensionContext;
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
   *  turns/restarts work by construction. Ordinarily ignored when resuming (the
   *  snapshot is already on the loaded state). A validated Persona instruction
   *  context is the narrow exception: a draft's first Activity or a successor
   *  Activity installs its newly pinned immutable Behavior snapshot. */
  flowDefinition?: Flow;

  /** Full message list (advanced; the OpenAI route passes its request messages). */
  messages?: FlowRunMessageInput[];
  /** Exact approved remote Skill identities selected for this user turn. */
  mcpSkillSelections?: import('@/shared/types/mcp').McpSkillSelection[];
  /** Convenience: a single user message. Used when `messages` is absent. */
  prompt?: string;
  /** Internal resumable-subflow continuation. For an EXISTING conversation,
   *  append the supplied input as a new turn instead of replacing its saved
   *  transcript, then re-enter the child flow from its Start node. Ignored for
   *  a fresh conversation. */
  resumeAsNewTurn?: boolean;
  /** Edit support: reset execution to this node (mirrors the legacy processNodeId). */
  processNodeId?: string;
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
  /** Sub-flows: ask for approval live in this conversation instead of pausing
   *  (a child run cannot pause on its own). See toolApprovalGate.ts. */
  approvalConversationId?: string;
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

  /**
   * Dispatcher-only exact MCP config names projected into this top-level
   * Persona Activity. Runtime-only; never serialized into a dispatch envelope
   * or inherited by structural/Behavior subflows.
   */
  personaCoreAppRefs?: string[];

  /**
   * Dispatcher-only, capability-free Persona identity/mission instructions.
   * This field is intentionally absent from serializable public input and from
   * SubflowNode child inputs; runFlow persists it only after validating the
   * exact attributed Activity and immutable Behavior root.
   */
  personaInstructionContext?: PersonaInstructionContext;

  /**
   * Dispatcher-authorized Behavior callables for this immutable Activity.
   * Stored separately from graph Subflow mappings and never forwarded to child
   * Behavior runs.
   */
  behaviorToolRegistry?: import('./handlers/behaviorToolInvocation').BehaviorToolRegistry;

  /** MeetingEngine-only participant identity. Never forwarded to subflows. */
  meetingParticipant?: SharedState['meetingParticipant'];
  /** MeetingEngine-only fresh action buffer for this participant turn. */
  meetingTurn?: SharedState['meetingTurn'];
}

export type FlowRunMessageInput = OpenAI.ChatCompletionMessageParam
  & Partial<Pick<FlujoChatMessage, 'id' | 'timestamp' | 'processNodeId'>>
  & { depth?: number };

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
  /** Every model this user turn sent a request to, or tried to, by model id. */
  modelsUsed?: string[];
  /** What the flow's rules decided in this stretch of the run, and why. */
  decisions?: FlowDecision[];
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
