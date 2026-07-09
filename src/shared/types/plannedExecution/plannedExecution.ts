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

export type TriggerConfig =
  | ScheduleTriggerConfig
  | WebhookTriggerConfig
  | FileWatchTriggerConfig
  | McpPollTriggerConfig
  | UrlWatchTriggerConfig;

export type TriggerType = TriggerConfig['type'];

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

export type RunRecordStatus = 'completed' | 'error' | 'skipped';

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
  /** Final assistant output, truncated for storage. */
  outputText?: string;
  usage?: UsageTotals;
  error?: string;
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
  kind: 'manual' | 'schedule' | 'schedule-catchup' | 'webhook' | 'file' | 'mcp-poll' | 'url-watch';
  /** Short human-readable summary, stored on the RunRecord. */
  summary: string;
  /** Structured data appended to the run prompt as a fenced JSON block. */
  context?: unknown;
}

/** Live (non-persisted) status of an execution's armed trigger, for the UI. */
export interface PlannedExecutionStatus {
  armed: boolean;
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
