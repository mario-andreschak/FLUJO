/**
 * Official MCP Tasks extension — wire contract (issue #404).
 *
 * PROTOCOL FREEZE (plan step 1). The contract below is pinned against the
 * repository's resolved `@modelcontextprotocol/sdk` (1.30.0,
 * `experimental/tasks`), which is the only Tasks implementation FLUJO can
 * actually interoperate with today. Two deviations from the planning notes are
 * deliberate and load-bearing:
 *
 *  - There is NO `resultType: "task"` discriminator and no `pollIntervalMs`
 *    field in the resolved SDK/spec. A task-augmented request returns
 *    `CreateTaskResult = { task: Task }`, and the poll interval hint is
 *    `Task.pollInterval` (milliseconds).
 *  - There is NO `tasks/update` method and no `inputRequests` array. The
 *    baseline method set is `tasks/get`, `tasks/result`, `tasks/cancel`
 *    (+ optional `tasks/list`). `input_required` is driven by the server
 *    issuing a *related* `elicitation/create` / `sampling/createMessage`
 *    request carrying `_meta["io.modelcontextprotocol/related-task"]`.
 *
 * Task augmentation is requested per request by adding `task: { ttl }` to the
 * request params (`TaskAugmentedRequestParams`), and is only legal when the
 * server advertised `capabilities.tasks.requests.tools.call`.
 *
 * Everything a remote server sends is untrusted: the parsers below validate
 * types and apply protective bounds, but never rewrite protocol meaning.
 */

/** Extension identifier, used for logging/documentation and capability gating. */
export const MCP_TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

/** `_meta` key that relates an inbound request to an in-flight task. */
export const MCP_RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/** Baseline (polling) method set FLUJO implements. */
export const MCP_TASK_METHODS = {
  get: 'tasks/get',
  result: 'tasks/result',
  cancel: 'tasks/cancel',
  list: 'tasks/list',
} as const;

/** Deferred, explicitly out of baseline scope (see issue #404). */
export const MCP_TASK_DEFERRED_METHODS = ['notifications/tasks/status'] as const;

export type McpTaskStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const MCP_TASK_STATUSES: readonly McpTaskStatus[] = [
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
];

const TERMINAL_STATUSES = new Set<McpTaskStatus>([
  'completed',
  'failed',
  'cancelled',
]);

export function isMcpTaskStatus(value: unknown): value is McpTaskStatus {
  return (
    typeof value === 'string' &&
    (MCP_TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminalMcpTaskStatus(status: McpTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * A pollable task as defined by the Tasks extension. `taskId` and `status` are
 * the only fields FLUJO requires: `ttl`/`createdAt`/`lastUpdatedAt` are
 * required by SDK 1.30.0 but have moved across draft revisions, so they are
 * validated when present and tolerated when absent rather than rejected (a
 * missing timestamp cannot change any lifecycle decision FLUJO makes).
 */
export interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  /** Retention window in ms after completion; `null` means unlimited. */
  ttl?: number | null;
  createdAt?: string;
  lastUpdatedAt?: string;
  /** Server-suggested poll interval, in milliseconds. */
  pollInterval?: number;
  /** Diagnostic message (failure reason / progress text). */
  statusMessage?: string;
}

export type McpTaskParseResult =
  | { ok: true; task: McpTask }
  | { ok: false; reason: string };

/** Hard cap on persisted/forwarded server-supplied status text. */
export const MCP_TASK_STATUS_MESSAGE_MAX_CHARS = 500;

/** Protective poll-interval bounds (documented in docs/mcp-tasks.md). */
export const MCP_TASK_POLL_MIN_MS = 1_000;
export const MCP_TASK_POLL_MAX_MS = 60_000;
export const MCP_TASK_POLL_DEFAULT_MS = 5_000;

/** Absolute cap on how long FLUJO honours a server-supplied TTL. */
export const MCP_TASK_MAX_TTL_MS = 24 * 60 * 60 * 1_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Truncate untrusted status text without changing its meaning. */
export function boundStatusMessage(
  message: string | undefined,
  maxChars = MCP_TASK_STATUS_MESSAGE_MAX_CHARS,
): string | undefined {
  if (typeof message !== 'string') return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

/**
 * Strictly validate an untrusted `Task` object. Unknown extra properties are
 * ignored (the spec schemas are loose), but every known field must have its
 * declared type — a wrong type is a protocol violation, not something to
 * coerce.
 */
export function parseMcpTask(value: unknown): McpTaskParseResult {
  if (!isPlainObject(value)) return { ok: false, reason: 'task is not an object' };

  const { taskId, status, ttl, createdAt, lastUpdatedAt, pollInterval, statusMessage } =
    value as Record<string, unknown>;

  if (typeof taskId !== 'string' || taskId.length === 0) {
    return { ok: false, reason: 'task.taskId must be a non-empty string' };
  }
  if (taskId.length > 512) {
    return { ok: false, reason: 'task.taskId exceeds 512 characters' };
  }
  if (!isMcpTaskStatus(status)) {
    return { ok: false, reason: `task.status is not a known task status` };
  }
  if (ttl !== undefined && ttl !== null && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0)) {
    return { ok: false, reason: 'task.ttl must be a non-negative number or null' };
  }
  if (createdAt !== undefined && typeof createdAt !== 'string') {
    return { ok: false, reason: 'task.createdAt must be an ISO 8601 string' };
  }
  if (lastUpdatedAt !== undefined && typeof lastUpdatedAt !== 'string') {
    return { ok: false, reason: 'task.lastUpdatedAt must be an ISO 8601 string' };
  }
  if (
    pollInterval !== undefined &&
    (typeof pollInterval !== 'number' || !Number.isFinite(pollInterval) || pollInterval < 0)
  ) {
    return { ok: false, reason: 'task.pollInterval must be a non-negative number of milliseconds' };
  }
  if (statusMessage !== undefined && typeof statusMessage !== 'string') {
    return { ok: false, reason: 'task.statusMessage must be a string' };
  }

  const task: McpTask = {
    taskId,
    status,
    ...(ttl === undefined ? {} : { ttl: ttl as number | null }),
    ...(typeof createdAt === 'string' ? { createdAt } : {}),
    ...(typeof lastUpdatedAt === 'string' ? { lastUpdatedAt } : {}),
    ...(typeof pollInterval === 'number' ? { pollInterval } : {}),
    ...(boundStatusMessage(statusMessage as string | undefined)
      ? { statusMessage: boundStatusMessage(statusMessage as string | undefined) }
      : {}),
  };
  return { ok: true, task };
}

/** Validate a `CreateTaskResult` (`{ task: Task }`) returned by tools/call. */
export function parseCreateTaskResult(value: unknown): McpTaskParseResult {
  if (!isPlainObject(value)) return { ok: false, reason: 'result is not an object' };
  if (!('task' in value)) return { ok: false, reason: 'result has no task field' };
  return parseMcpTask(value.task);
}

/**
 * Validate a `tasks/get` / `tasks/cancel` result. SDK 1.30.0 merges the Task
 * into the *top level* of those results, while `CreateTaskResult` nests it
 * under `task`; both shapes are accepted so FLUJO interoperates with servers
 * built against either revision.
 */
export function parseTaskStatusResult(value: unknown): McpTaskParseResult {
  if (!isPlainObject(value)) return { ok: false, reason: 'result is not an object' };
  const direct = parseMcpTask(value);
  if (direct.ok) return direct;
  if ('task' in value) return parseMcpTask(value.task);
  return direct;
}

/**
 * Decide whether a tools/call response is a task handle or a classic
 * `CallToolResult`.
 *
 * Rules (plan step 2):
 *  - A response carrying `content` / `structuredContent` is ALWAYS a classic
 *    result, even if it also happens to contain a `task` key.
 *  - Otherwise a task lifecycle starts only for a schema-valid `{ task }`
 *    result. When FLUJO explicitly requested task augmentation, an invalid
 *    `task` payload is reported as a protocol violation instead of being
 *    silently treated as a normal result.
 */
export type ToolCallResultKind =
  | { kind: 'classic' }
  | { kind: 'task'; task: McpTask }
  | { kind: 'protocol-invalid'; reason: string };

export function classifyToolCallResult(
  response: unknown,
  options: { taskRequested: boolean },
): ToolCallResultKind {
  if (!isPlainObject(response)) return { kind: 'classic' };

  // A payload with tool-result fields is a classic result even when it also
  // carries a `task` key: the synchronous result is the documented fallback
  // and must never be reinterpreted as a task handle.
  if ('content' in response || 'structuredContent' in response) {
    return { kind: 'classic' };
  }

  if (!('task' in response)) {
    return options.taskRequested
      ? { kind: 'protocol-invalid', reason: 'task-augmented request returned neither a task nor a tool result' }
      : { kind: 'classic' };
  }

  const parsed = parseCreateTaskResult(response);
  if (parsed.ok) return { kind: 'task', task: parsed.task };
  return { kind: 'protocol-invalid', reason: parsed.reason };
}

/** Clamp an untrusted poll interval into FLUJO's documented bounds. */
export function clampPollIntervalMs(
  pollInterval: number | undefined,
  bounds: { minMs?: number; maxMs?: number; defaultMs?: number } = {},
): number {
  const minMs = bounds.minMs ?? MCP_TASK_POLL_MIN_MS;
  const maxMs = Math.max(minMs, bounds.maxMs ?? MCP_TASK_POLL_MAX_MS);
  const fallback = bounds.defaultMs ?? MCP_TASK_POLL_DEFAULT_MS;
  const requested =
    typeof pollInterval === 'number' && Number.isFinite(pollInterval) && pollInterval > 0
      ? pollInterval
      : fallback;
  return Math.min(Math.max(requested, minMs), maxMs);
}

/**
 * Compute the local expiry timestamp for a task. `ttl: null` means "no
 * expiry"; a missing ttl falls back to the caller-supplied default so a task
 * can never be polled forever.
 */
export function computeTaskExpiresAt(
  task: McpTask,
  nowMs: number,
  fallbackTtlMs: number,
): number | undefined {
  if (task.ttl === null) return undefined;
  const ttl =
    typeof task.ttl === 'number' && Number.isFinite(task.ttl) && task.ttl > 0
      ? Math.min(task.ttl, MCP_TASK_MAX_TTL_MS)
      : Math.min(Math.max(fallbackTtlMs, 0), MCP_TASK_MAX_TTL_MS);
  if (ttl <= 0) return undefined;
  return nowMs + ttl;
}

/** Extract the related-task id from an inbound request's `_meta`, if any. */
export function relatedTaskIdOf(meta: unknown): string | undefined {
  if (!isPlainObject(meta)) return undefined;
  const related = meta[MCP_RELATED_TASK_META_KEY];
  if (!isPlainObject(related)) return undefined;
  const taskId = related.taskId;
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : undefined;
}
