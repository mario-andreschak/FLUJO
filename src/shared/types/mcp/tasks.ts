/**
 * Official MCP Tasks extension — wire contract (issue #404).
 *
 * Legacy compatibility contract. The original contract below is pinned against the
 * repository's resolved `@modelcontextprotocol/sdk` (1.x,
 * `experimental/tasks`), which is the only Tasks implementation FLUJO can
 * 2025-11-25 generation. The 2026-07-28 extension is validated separately and
 * normalized only after explicit generation selection. Two legacy differences are
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
import { CreateMessageRequestSchema, ElicitRequestSchema, ListRootsRequestSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

export const MCP_TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
export type McpTaskGeneration = '2025-11-25' | '2026-07-28';
export type McpTaskInputRequest = { method: 'elicitation/create' | 'sampling/createMessage' | 'roots/list'; params?: Record<string, unknown> };

/** `_meta` key that relates an inbound request to an in-flight task. */
export const MCP_RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/** Baseline (polling) method set FLUJO implements. */
export const MCP_TASK_METHODS = {
  get: 'tasks/get',
  result: 'tasks/result',
  cancel: 'tasks/cancel',
  list: 'tasks/list',
  update: 'tasks/update',
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
 * required by SDK 1.x but have moved across draft revisions, so they are
 * validated when present and tolerated when absent rather than rejected (a
 * missing timestamp cannot change any lifecycle decision FLUJO makes).
 */
export interface McpTask {
  generation?: McpTaskGeneration;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
  inputRequests?: Record<string, McpTaskInputRequest>;
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

/** Bound decoded remote JSON before schema traversal or durable retention. */
export function isBoundedTaskJson(value: unknown): boolean {
  let entries = 0, chars = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++entries > 10_000 || depth > 32) return false;
    if (typeof item === 'string') { chars += item.length; return chars <= 1024 * 1024; }
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    const keys = Object.keys(item);
    if (keys.length > 10_000) return false;
    for (const key of keys) {
      chars += key.length;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (chars > 1024 * 1024 || !descriptor || !('value' in descriptor) || !visit(descriptor.value, depth + 1)) return false;
    }
    seen.delete(item); return true;
  };
  return visit(value, 0);
}

export function isValidTaskToolResult(value: unknown): value is Record<string, unknown> {
  // Modern structuredContent is any JSON value, while SDK 1.x restricts it to
  // an object. Validate the remaining tool result using the pinned SDK without
  // coercing or dropping the separately bounded modern structured value.
  if (!isPlainObject(value) || !Array.isArray(value.content) || !isBoundedTaskJson(value)) return false;
  const { structuredContent: _structuredContent, ...sdkResult } = value;
  return CallToolResultSchema.safeParse(sdkResult).success;
}

function parseModernTask(value: unknown, creation: boolean): McpTaskParseResult {
  const invalid = (reason: string): McpTaskParseResult => ({ ok: false, reason });
  if (!isPlainObject(value) || !isBoundedTaskJson(value)) return invalid('unbounded or invalid modern task');
  if (value.resultType !== (creation ? 'task' : 'complete') || 'task' in value || 'ttl' in value || 'pollInterval' in value) return invalid('invalid modern discriminator or mixed generation');
  if (creation && ('content' in value || 'structuredContent' in value)) return invalid('invalid creation payload');
  if (!(value.ttlMs === null || (Number.isSafeInteger(value.ttlMs) && Number(value.ttlMs) >= 0))) return invalid('invalid ttlMs');
  if (value.pollIntervalMs !== undefined && (!Number.isSafeInteger(value.pollIntervalMs) || Number(value.pollIntervalMs) < 0)) return invalid('invalid pollIntervalMs');
  for (const field of ['createdAt', 'lastUpdatedAt']) {
    if (typeof value[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value[field]) || !Number.isFinite(Date.parse(value[field]))) return invalid('invalid task timestamp');
  }
  const parsed = parseMcpTask({ taskId: value.taskId, status: value.status, createdAt: value.createdAt,
    lastUpdatedAt: value.lastUpdatedAt, statusMessage: value.statusMessage, ttl: value.ttlMs, pollInterval: value.pollIntervalMs });
  if (!parsed.ok) return parsed;
  const task: McpTask = { ...parsed.task, generation: '2026-07-28' };
  if (!creation || 'result' in value || 'error' in value || 'inputRequests' in value) {
    if (task.status === 'completed') {
      if (!isValidTaskToolResult(value.result)) return invalid('invalid terminal tool result');
      task.result = value.result;
    } else if (task.status === 'failed') {
      if (!isPlainObject(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== 'string' || value.error.message.length > 4096) return invalid('invalid task JSON-RPC error');
      task.error = { code: Number(value.error.code), message: value.error.message, ...('data' in value.error ? { data: value.error.data } : {}) };
    } else if (task.status === 'input_required') {
      if (!isPlainObject(value.inputRequests) || Object.keys(value.inputRequests).length > 32) return invalid('invalid input request map');
      const requests: Record<string, McpTaskInputRequest> = Object.create(null);
      for (const [key, request] of Object.entries(value.inputRequests)) {
        if (!key || key.length > 512 || !isPlainObject(request) || (request.params !== undefined && !isPlainObject(request.params))) return invalid('invalid input request');
        const schema = request.method === 'elicitation/create' ? ElicitRequestSchema : request.method === 'sampling/createMessage' ? CreateMessageRequestSchema : request.method === 'roots/list' ? ListRootsRequestSchema : undefined;
        if (!schema?.safeParse(request).success) return invalid('unsupported or invalid input request');
        requests[key] = request as McpTaskInputRequest;
      }
      task.inputRequests = requests;
    }
    if ((task.status !== 'completed' && 'result' in value) || (task.status !== 'failed' && 'error' in value) || (task.status !== 'input_required' && 'inputRequests' in value)) return invalid('inconsistent task status payload');
  }
  return { ok: true, task };
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
  if ('ttlMs' in value || 'pollIntervalMs' in value || 'resultType' in value) return { ok: false, reason: 'modern task supplied to legacy parser' };

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
export function parseCreateTaskResult(value: unknown, generation: McpTaskGeneration = '2025-11-25'): McpTaskParseResult {
  if (generation === '2026-07-28') return parseModernTask(value, true);
  if (!isPlainObject(value)) return { ok: false, reason: 'result is not an object' };
  if ('resultType' in value || 'ttlMs' in value) return { ok: false, reason: 'mixed task generations' };
  if (!('task' in value)) return { ok: false, reason: 'result has no task field' };
  return parseMcpTask(value.task);
}

/**
 * Validate a `tasks/get` / `tasks/cancel` result. SDK 1.x merges the Task
 * into the *top level* of those results, while `CreateTaskResult` nests it
 * under `task`; both shapes are accepted so FLUJO interoperates with servers
 * built against either revision.
 */
export function parseTaskStatusResult(value: unknown, generation: McpTaskGeneration = '2025-11-25'): McpTaskParseResult {
  if (generation === '2026-07-28') return parseModernTask(value, false);
  if (!isPlainObject(value)) return { ok: false, reason: 'result is not an object' };
  if ('resultType' in value || 'ttlMs' in value || 'pollIntervalMs' in value) return { ok: false, reason: 'mixed task generations' };
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
  options: { taskRequested: boolean; generation?: McpTaskGeneration },
): ToolCallResultKind {
  if (!isPlainObject(response)) return { kind: 'classic' };
  if (options.generation !== '2026-07-28' && response.resultType === 'task') return { kind: 'protocol-invalid', reason: 'modern task on legacy connection' };
  if (options.generation === '2026-07-28') {
    if (response.resultType === 'task') {
      if (!options.taskRequested) return { kind: 'protocol-invalid', reason: 'unnegotiated modern task' };
      const parsed = parseCreateTaskResult(response, options.generation);
      return parsed.ok ? { kind: 'task', task: parsed.task } : { kind: 'protocol-invalid', reason: parsed.reason };
    }
    if ('task' in response && !('content' in response || 'structuredContent' in response)) return { kind: 'protocol-invalid', reason: 'legacy task on modern connection' };
    return { kind: 'classic' };
  }

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
  if (task.generation === '2026-07-28') {
    if (task.ttl === null) return undefined;
    const created = Date.parse(task.createdAt ?? '');
    return created + Math.min(task.ttl ?? fallbackTtlMs, MCP_TASK_MAX_TTL_MS);
  }
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
