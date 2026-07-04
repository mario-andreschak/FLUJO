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
   * condition. Costs one completion per poll — budget-capped.
   */
  | { mode: 'llm-gate'; condition: string; modelId: string; maxCallsPerDay?: number };

export interface McpPollTriggerConfig {
  type: 'mcp-poll';
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Poll interval in ms. Enforced minimum: 30 000. */
  intervalMs: number;
  evaluate: McpPollEvaluate;
}

export type TriggerConfig =
  | ScheduleTriggerConfig
  | WebhookTriggerConfig
  | FileWatchTriggerConfig
  | McpPollTriggerConfig;

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
}

/** What a trigger hands to the scheduler when it fires. */
export interface TriggerFirePayload {
  kind: 'manual' | 'schedule' | 'schedule-catchup' | 'webhook' | 'file' | 'mcp-poll';
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
}
