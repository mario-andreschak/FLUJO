/**
 * Durable, ownership-scoped record of a REMOTE MCP task (issue #404, plan
 * step 6).
 *
 * This is deliberately a separate model from `src/shared/types/subflowTasks.ts`:
 * a detached subflow task is executed *by* FLUJO and is failed on restart,
 * whereas a remote MCP task is owned by another process and may legitimately
 * survive a FLUJO restart — so it is resumed when (and only when) the exact
 * server/config identity still matches.
 *
 * Privacy contract: this record never stores tool arguments, credentials,
 * headers, elicited input, or terminal result payloads. Requests are
 * identified by a salted-free, non-reversible-enough fingerprint (a truncated
 * SHA-256 of the normalized argument JSON) which is only used for diagnostics
 * and duplicate detection; results stay on the remote server and are re-fetched
 * through `tasks/result`.
 */

import type { McpTaskStatus } from './tasks';

export const MCP_REMOTE_TASK_RECORD_VERSION = 1;

/** Storage collection name (db/mcp-remote-tasks/<recordId>.json). */
export const MCP_REMOTE_TASK_COLLECTION = 'mcp-remote-tasks';

/** Why a record is no longer being polled, when that is not a protocol state. */
export type McpRemoteTaskDiagnostic =
  | 'server-missing'
  | 'server-disconnected'
  | 'identity-mismatch'
  | 'expired'
  | 'protocol-invalid'
  | 'transport-error'
  | 'input-required-unattended'
  | 'process-restart-resumed'
  | 'owner-unavailable'
  | 'poll-limit';

export interface McpRemoteTaskOwnership {
  /** Conversation that owns the originating run, when known. */
  conversationId?: string;
  /** Flow node that issued the call, when known. */
  nodeId?: string;
  /** FLUJO owner scope string already threaded through callTool(). */
  ownerScope?: string;
  /** Caller class of the originating tool call (host/model/app). */
  source?: string;
}

export interface McpRemoteTaskRecord {
  version: typeof MCP_REMOTE_TASK_RECORD_VERSION;
  /** Local, collection-safe record id. NEVER the remote task id. */
  recordId: string;

  /** Remote identity — all three must match before any follow-up request. */
  remoteTaskId: string;
  serverName: string;
  /** Fingerprint of the server config/auth identity (see remoteTaskStore). */
  serverIdentity: string;

  /** Originating operation. */
  toolName: string;
  /** Truncated SHA-256 of the normalized arguments; never the arguments. */
  requestFingerprint: string;

  ownership: McpRemoteTaskOwnership;

  status: McpTaskStatus;
  statusMessage?: string;
  /** Elicitation ids seen for this task that have not been answered yet. */
  outstandingInputKeys?: string[];

  createdAt: number;
  updatedAt: number;
  lastPolledAt?: number;
  nextPollAt?: number;
  pollIntervalMs: number;
  pollCount?: number;

  ttlMs?: number;
  expiresAt?: number;
  cancelRequestedAt?: number;
  completedAt?: number;

  /** True once a terminal result was successfully retrieved (payload not stored). */
  resultRetrieved?: boolean;
  /** Bounded, redacted failure text. */
  errorMessage?: string;
  diagnostic?: McpRemoteTaskDiagnostic;
}

export interface McpRemoteTaskSettings {
  /** Retention for terminal/expired records, in days. 0 disables sweeping. */
  retentionAgeDays: number;
  /** Fallback poll interval when the server does not suggest one. */
  defaultPollIntervalMs: number;
  minPollIntervalMs: number;
  maxPollIntervalMs: number;
  /** TTL requested from the server for FLUJO-initiated task augmentation. */
  requestedTtlMs: number;
  /** Fallback expiry applied when a server omits ttl. */
  fallbackTtlMs: number;
  /** Global cap on concurrently polled remote tasks. */
  maxConcurrentPolls: number;
  /** Per-server cap on concurrently polled remote tasks. */
  maxConcurrentPollsPerServer: number;
  /** Consecutive transient transport failures tolerated before failing closed. */
  maxTransientPollFailures: number;
  /** How long a task may sit in `input_required` before FLUJO cancels it. */
  inputRequiredTimeoutMs: number;
  /** Records resumed per startup sweep. */
  maxResumePerStartup: number;
}

export const DEFAULT_MCP_REMOTE_TASK_SETTINGS: McpRemoteTaskSettings = {
  retentionAgeDays: 7,
  defaultPollIntervalMs: 5_000,
  minPollIntervalMs: 1_000,
  maxPollIntervalMs: 60_000,
  requestedTtlMs: 60 * 60 * 1_000,
  fallbackTtlMs: 60 * 60 * 1_000,
  maxConcurrentPolls: 16,
  maxConcurrentPollsPerServer: 4,
  maxTransientPollFailures: 5,
  inputRequiredTimeoutMs: 5 * 60 * 1_000,
  maxResumePerStartup: 25,
};

const TERMINAL = new Set<McpTaskStatus>(['completed', 'failed', 'cancelled']);
const MCP_TASK_STATUS_SET = new Set<McpTaskStatus>([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Legal state transitions. Terminal states are immutable, which is what makes
 * the completion-versus-cancellation race deterministic: whichever terminal
 * state is persisted first wins.
 */
export function isLegalRemoteTaskTransition(
  from: McpTaskStatus,
  to: McpTaskStatus,
): boolean {
  // Terminal records are immutable — including a repeat of the same terminal
  // state, so a late `cancelled` can never overwrite a persisted `completed`.
  if (TERMINAL.has(from)) return false;
  // Any non-terminal state may move to any other state, including itself
  // (a status re-poll that reports no change).
  return MCP_TASK_STATUS_SET.has(to);
}

export function isTerminalRemoteTaskRecord(record: McpRemoteTaskRecord): boolean {
  return TERMINAL.has(record.status);
}
