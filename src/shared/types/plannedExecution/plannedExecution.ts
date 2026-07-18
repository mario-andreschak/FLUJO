import type { UsageTotals } from '@/shared/types/execution/events';

/**
 * Planned Executions (#10): flows that run headlessly on triggers.
 *
 * A PlannedExecution binds ONE flow to ONE trigger. When the trigger fires,
 * the scheduler runs the flow via runFlow (ephemeral by default) with the
 * configured prompt plus a structured "trigger context" block describing what
 * fired (webhook payload, changed file, new poll items, ...).
 */

/** Events a file-watch trigger can react to. */
export type FileWatchEvent = 'add' | 'change' | 'unlink';

export interface ScheduleTriggerConfig {
  type: 'schedule';
  /** Standard 5/6-field cron pattern (croner syntax, seconds optional). */
  cron: string;
  /** IANA timezone (e.g. "Europe/Berlin"). Defaults to the server's local tz. */
  timezone?: string;
  /**
   * When true and FLUJO was closed while a run was due, run ONCE at startup.
   * Never replays every missed occurrence — one catch-up run at most.
   */
  catchUp?: boolean;
}

export interface WebhookTriggerConfig {
  type: 'webhook';
  /** Shared secret required on every call (X-Flujo-Token header or ?token=). */
  token: string;
  /** Allow non-localhost callers. Off by default (single-user assumption). */
  allowExternal?: boolean;
}

export interface FileWatchTriggerConfig {
  type: 'file-watch';
  /** Directory (or single file) to watch. */
  path: string;
  /** Optional glob applied to paths inside the watched directory. */
  glob?: string;
  /** Which file events fire the flow. */
  events: FileWatchEvent[];
  /** Quiet window that batches a burst of events into one run. Default 2000. */
  debounceMs?: number;
}

/** How an MCP poll result is evaluated to decide whether to fire (v2). */
export type McpPollEvaluate =
  /** Fire whenever the (normalized) tool result differs from the last poll. */
  | { mode: 'on-change' }
  /**
   * Treat part of the result as a list; fire when items with unseen ids
   * appear (the classic polling-cursor model).
   */
  | { mode: 'new-items'; itemsPath: string; idField: string }
  /**
   * Ask a pinned model whether the result satisfies a natural-language
   * condition. Costs one completion per (changed) poll — budget-capped.
   */
  | { mode: 'llm-gate'; condition: string; modelId: string; maxCallsPerDay?: number }
  /**
   * Let one of the user's FLOWS decide (ephemeral run): the flow gets the
   * condition + tool result and must answer with the same {"fire": …} JSON.
   * Strictly more powerful than llm-gate — the flow can use tools to verify.
   */
  | { mode: 'flow-gate'; condition: string; flowId: string; maxCallsPerDay?: number };

export interface McpPollTriggerConfig {
  type: 'mcp-poll';
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  /**
   * When to check, as a cron pattern (croner; 6-field form for seconds).
   * Always set on save; may be absent on configs saved before the cron
   * switch — those derive it from the legacy intervalMs at arm time.
   */
  cron?: string;
  timezone?: string;
  /** LEGACY (pre-cron): poll interval in ms. Superseded by `cron`. */
  intervalMs?: number;
  evaluate: McpPollEvaluate;
}

export interface UrlWatchTriggerConfig {
  type: 'url-watch';
  /** The http(s) resource to watch. */
  url: string;
  /** When to check, as a cron pattern (same editor as schedule triggers). */
  cron: string;
  timezone?: string;
}

/**
 * Flow-run event trigger (issue #116): fire when ANOTHER flow reaches a
 * terminal state. Lets one planned execution react to a different flow
 * completing or erroring — "run triage when X errors", "run B after A finishes"
 * — without any external glue. Delivery is in-process: a source run just
 * finished, so the process is up. Loop-safety is built in via an event-chain
 * depth cap (`maxChainDepth`) plus an optional cooldown (`minIntervalMs`); the
 * scheduler's existing overlap-skip guards a single execution against
 * self-retrigger storms.
 */
export interface FlowEventTriggerConfig {
  type: 'flow-event';
  /**
   * What upstream event to react to. EXACTLY ONE of the four must be set:
   *  - `executionId`  — a specific planned execution's runs (most precise).
   *  - `flowId`       — any run of a given flow (chat/API/manual/scheduled).
   *  - `flowName`     — same, matched by the flow's current name.
   *  - `topic`        — a `signal` node emission with this topic (issue #117):
   *                     a deterministic, mid-run event rather than a terminal
   *                     run. Free-form name (no registry), like a webhook id.
   */
  source: { flowId?: string; flowName?: string; executionId?: string; topic?: string };
  /**
   * Which terminal statuses fire this trigger. Required for a flow/execution
   * source; ignored for a `topic` (signal) source, which has no completed/error
   * status (issue #117).
   */
  on?: Array<'completed' | 'error'>;
  /** Optional filter on the upstream run's final output text (or, for a topic
   *  source, on the signal's payload). */
  outputMatch?: { contains?: string; regex?: string };
  /**
   * Loop safety: refuse to fire once the event-chain depth reaches this many
   * hops (a `skipped` run is recorded instead). Default 5.
   */
  maxChainDepth?: number;
  /** Minimum gap between fires of THIS trigger, in ms (extra loop clamp). */
  minIntervalMs?: number;
}

export type TriggerConfig =
  | ScheduleTriggerConfig
  | WebhookTriggerConfig
  | FileWatchTriggerConfig
  | McpPollTriggerConfig
  | UrlWatchTriggerConfig
  | FlowEventTriggerConfig;

export type TriggerType = TriggerConfig['type'];

/**
 * What to do when a trigger fires while a previous run for THIS execution is
 * still in flight (issue #121). Overlap is tracked per execution, not per
 * trigger, so the policy lives on PlannedExecution (below) rather than on each
 * TriggerConfig member.
 *  - 'skip'     (default, historical behavior) — drop the new fire, recording
 *               a `skipped` run so the event stays auditable.
 *  - 'queue'    — defer the new fire (FIFO) and run it once the current run
 *               finishes. Bounded by a queue-depth cap; over the cap the fire
 *               is skipped.
 *  - 'parallel' — run concurrently; overlapping runs are allowed.
 *  - 'error'    — reject the new fire, recording an `error` run (and, for the
 *               webhook path, a 409 response).
 */
export type OverlapStrategy = 'skip' | 'queue' | 'parallel' | 'error';

export interface PlannedExecution {
  id: string;
  name: string;
  enabled: boolean;
  /** The flow to run when the trigger fires. */
  flowId: string;
  /**
   * User prompt for the run. The trigger payload is appended as a fenced JSON
   * context block, so the prompt should describe what to DO with that context.
   */
  prompt: string;
  /**
   * When true, runs persist as normal conversations (visible in the chat
   * sidebar, deep-linkable). Default false = ephemeral + run history only.
   */
  saveConversations?: boolean;
  /**
   * What a HEADLESS run does when it reaches a tool that needs approval
   * (issue #115). A scheduled run has no interactive approver, so:
   *  - 'auto'  (default) — tools run without approval (today's behavior).
   *  - 'fail'  — fail fast: the run ends with a structured `needs_approval`
   *              outcome and the tool is NOT executed (no silent auto-approve,
   *              no hang).
   *  - 'pause' — persist the run (awaiting_tool_approval) so an external caller
   *              can resume it later via the approval inbox
   *              (GET/POST /api/approvals). Implies conversation mode so the
   *              paused state survives to be resumed.
   */
  approvalPolicy?: 'auto' | 'fail' | 'pause';
  /**
   * Overlap policy when a fire arrives while a previous run for THIS execution
   * is still running (issue #121). Defaults to 'skip' (historical behavior)
   * when absent, so existing persisted configs keep working without migration.
   */
  overlapStrategy?: OverlapStrategy;
  trigger: TriggerConfig;
  createdAt: string;
  updatedAt: string;
}

/** Envelope persisted at db/planned_executions.json. */
export interface PlannedExecutionsFile {
  version: 1;
  /** Global pause switch — when true nothing is armed. */
  paused: boolean;
  executions: PlannedExecution[];
}

export type RunRecordStatus = 'completed' | 'error' | 'skipped' | 'needs_approval';

/** One entry in an execution's run history (ring buffer, newest last). */
export interface RunRecord {
  runId: string;
  /** Conversation id of the run (ephemeral unless saveConversations). */
  conversationId: string;
  firedAt: string;
  finishedAt?: string;
  status: RunRecordStatus;
  /** Short human-readable description of what fired ("Schedule", "Webhook", ...). */
  triggerSummary: string;
  /** Final assistant output, truncated for storage. Surfaced in run history and
   *  carried on the flow-run event bus (FlowRunEvent.outputText) so downstream
   *  flow-event triggers can chain it explicitly. */
  outputText?: string;
  usage?: UsageTotals;
  error?: string;
  /**
   * Set when a HEADLESS run hit a tool that needs approval (issue #115): the
   * run either failed fast (approvalPolicy 'fail') or is parked awaiting
   * approval ('pause'). Carries the pending tool call(s) so an approval inbox
   * can surface them. Metadata only — never tool arguments.
   */
  pendingApproval?: {
    /** The first tool that required approval (fail-fast convenience). */
    tool?: string;
    toolCallId?: string;
    /** All tool calls in the batch awaiting approval (id + name only). */
    pendingToolCalls?: Array<{ id: string; name: string }>;
  };
}

/**
 * Per-execution mutable trigger state, persisted separately from the config so
 * routine updates never churn db/planned_executions.json.
 */
export interface PlannedExecutionState {
  /** Last time the schedule trigger fired (drives the catch-up check). */
  lastScheduledFireAt?: string;
  /** on-change: hash of the last seen tool result. */
  lastHash?: string;
  /** new-items: ids already seen (capped). */
  seenIds?: string[];
  /** llm-gate: day stamp (YYYY-MM-DD) + count for the daily call cap. */
  llmCallsDay?: string;
  llmCallsCount?: number;
  /**
   * Commit-after-success (issue #75): number of consecutive times a DETECTED
   * change (on-change / new-items / url-watch) fired a run that did NOT
   * complete (crashed/errored). The baseline (lastHash/seenIds) is only
   * advanced once a fired run completes, so the change is retried; this
   * counter bounds that retry so a change that reliably breaks the flow can't
   * re-fire forever. Reset to 0 on the first successful delivery. Overlap
   * skips do NOT count (the run was never attempted).
   */
  pendingFailures?: number;
}

/** What a trigger hands to the scheduler when it fires. */
export interface TriggerFirePayload {
  kind:
    | 'manual'
    | 'schedule'
    | 'schedule-catchup'
    | 'webhook'
    | 'file'
    | 'mcp-poll'
    | 'url-watch'
    | 'flow-event';
  /** Short human-readable summary, stored on the RunRecord. */
  summary: string;
  /** Structured data appended to the run prompt as a fenced JSON block. */
  context?: unknown;
  /**
   * Event-chain depth of the run this fire produces (issue #116). Organic runs
   * (schedule/webhook/file/poll/manual, or any chat/API run) are depth 0; a run
   * fired by a `flow-event` trigger reacting to a depth-N run is depth N+1. The
   * scheduler stamps it onto the emitted FlowRunEvent so `maxChainDepth` can
   * break runaway A→B→A loops. Distinct from runFlow's subflow `runDepth`.
   */
  chainDepth?: number;
}

/** Live (non-persisted) status of an execution's armed trigger, for the UI. */
export interface PlannedExecutionStatus {
  armed: boolean;
  /**
   * When NOT armed, why — so the UI can show a truthful reason instead of a
   * bare "Not armed" (issue #118). 'paused' = the global pause switch gates
   * every trigger; 'disabled' = this execution's own enable toggle is off.
   * Undefined when armed, or when not armed for some other (error/idle) reason.
   */
  notArmedReason?: 'paused' | 'disabled';
  /** Next scheduled fire time (schedule triggers only). */
  nextRun?: string | null;
  /** Most recent trigger-level error (e.g. failed poll or watcher error). */
  lastTriggerError?: string;
  /**
   * True while a run for this execution is in flight (overlap tracking). Lets
   * the UI show a live "Running…" state without opening the chat and without
   * waiting for the run to finish — issue #50.
   */
  running: boolean;
  /** ISO time the in-flight run started, for a live elapsed timer. */
  runningSince?: string;
}
