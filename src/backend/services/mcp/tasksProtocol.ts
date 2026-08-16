/**
 * MCP Tasks extension — protocol/SDK adapter (issue #404, plan step 1 & 3).
 *
 * This module is the ONLY place in FLUJO that talks to the experimental Tasks
 * APIs of `@modelcontextprotocol/sdk` (pinned: 1.30.0, `experimental/tasks`).
 * Everything else consumes the narrow, validated surface exported here, so an
 * SDK/spec revision only has to be absorbed in this file.
 *
 * Frozen baseline (see shared/types/mcp/tasks.ts for the full contract):
 *  - request task augmentation with `params.task = { ttl }`;
 *  - poll `tasks/get`, fetch the payload with `tasks/result`, cancel with
 *    `tasks/cancel`; `tasks/list` is optional and unused by the lifecycle;
 *  - `notifications/tasks/status` and `subscriptions/listen` are deferred.
 *
 * Deliberate deviation from the planning note: the resolved SDK/spec has no
 * `resultType: "task"` discriminator, no `pollIntervalMs`, and no
 * `tasks/update`. Task support is negotiated through the SERVER capability
 * `capabilities.tasks.requests.tools.call` plus the per-request `task` param —
 * FLUJO therefore declares no `tasks` CLIENT capability, because it hosts no
 * tasks of its own (that capability describes client-side task creation for
 * sampling/elicitation, which remains out of scope).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CancelTaskResultSchema,
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { FEATURES } from '@/config/features';
import {
  MCP_TASK_METHODS,
  MCP_TASKS_EXTENSION_ID,
  parseTaskStatusResult,
  type McpTask,
} from '@/shared/types/mcp/tasks';
import { getMcpRemoteTaskSettings } from './remoteTaskStore';

const log = createLogger('backend/services/mcp/tasksProtocol');

/** Client-side Tasks master switch (governs negotiation AND persistence). */
export function mcpTasksClientEnabled(): boolean {
  return FEATURES.ENABLE_MCP_TASKS_CLIENT === true;
}

/** Server-side Tasks master switch. Intentionally unimplemented (see docs). */
export function mcpTasksServerEnabled(): boolean {
  return FEATURES.ENABLE_MCP_TASKS_SERVER === true;
}

export interface TaskNegotiation {
  /** Feature flag on AND the live server advertised tools/call task support. */
  supported: boolean;
  supportsToolsCall: boolean;
  supportsCancel: boolean;
  supportsList: boolean;
}

interface ClientWithCapabilities {
  getServerCapabilities?: () => Record<string, unknown> | undefined;
}

/**
 * Cached per LIVE CLIENT OBJECT. Reconnects and configuration/auth changes
 * always produce a brand-new Client instance (see connection.ts
 * shouldRecreateClient), so a stale capability snapshot can never outlive the
 * connection identity it was captured from.
 */
const negotiationCache = new WeakMap<object, TaskNegotiation>();

function readServerTasksCapability(client: Client): Record<string, unknown> | undefined {
  try {
    const caps = (client as unknown as ClientWithCapabilities).getServerCapabilities?.();
    const tasks = caps?.tasks;
    return typeof tasks === 'object' && tasks !== null
      ? (tasks as Record<string, unknown>)
      : undefined;
  } catch (error) {
    log.warn('Failed to read server capabilities for Tasks negotiation', error);
    return undefined;
  }
}

/**
 * Capture (and memoize) the server's advertised Tasks support for this exact
 * connection. Returns an all-false negotiation when the feature is disabled, so
 * no Tasks metadata is ever sent to a classic or incompatible server.
 */
export function getTaskNegotiation(client: Client | undefined): TaskNegotiation {
  const none: TaskNegotiation = {
    supported: false,
    supportsToolsCall: false,
    supportsCancel: false,
    supportsList: false,
  };
  if (!client || !mcpTasksClientEnabled()) return none;

  const cached = negotiationCache.get(client as unknown as object);
  if (cached) return cached;

  const tasks = readServerTasksCapability(client);
  if (!tasks) {
    negotiationCache.set(client as unknown as object, none);
    return none;
  }

  const requests = (tasks.requests ?? undefined) as Record<string, unknown> | undefined;
  const tools = (requests?.tools ?? undefined) as Record<string, unknown> | undefined;
  const supportsToolsCall = typeof tools?.call === 'object' && tools.call !== null;

  const negotiation: TaskNegotiation = {
    supported: supportsToolsCall,
    supportsToolsCall,
    supportsCancel: typeof tasks.cancel === 'object' && tasks.cancel !== null,
    supportsList: typeof tasks.list === 'object' && tasks.list !== null,
  };
  negotiationCache.set(client as unknown as object, negotiation);
  log.debug(`Negotiated ${MCP_TASKS_EXTENSION_ID} support`, negotiation);
  return negotiation;
}

/** Drop a cached negotiation (used by tests and explicit reconnect paths). */
export function invalidateTaskNegotiation(client: Client | undefined): void {
  if (client) negotiationCache.delete(client as unknown as object);
}

/** Per-tool `execution.taskSupport` declaration, cached briefly per client. */
type ToolTaskSupport = 'optional' | 'required' | 'forbidden' | undefined;
interface ToolSupportSnapshot {
  at: number;
  byTool: Map<string, ToolTaskSupport>;
}
const TOOL_SUPPORT_TTL_MS = 60_000;
const toolSupportCache = new WeakMap<object, ToolSupportSnapshot>();

async function getToolTaskSupport(
  client: Client,
  toolName: string,
): Promise<ToolTaskSupport> {
  const key = client as unknown as object;
  const cached = toolSupportCache.get(key);
  if (cached && Date.now() - cached.at < TOOL_SUPPORT_TTL_MS) {
    return cached.byTool.get(toolName);
  }
  try {
    const listed = await client.listTools();
    const byTool = new Map<string, ToolTaskSupport>();
    for (const tool of listed.tools ?? []) {
      const execution = (tool as unknown as { execution?: { taskSupport?: string } }).execution;
      const support = execution?.taskSupport;
      byTool.set(
        tool.name,
        support === 'optional' || support === 'required' || support === 'forbidden'
          ? support
          : undefined,
      );
    }
    toolSupportCache.set(key, { at: Date.now(), byTool });
    return byTool.get(toolName);
  } catch (error) {
    log.warn(`Failed to read tool task-support declarations: ${String(error)}`);
    return undefined;
  }
}

export interface TaskAugmentationDecision {
  /** Whether to add `params.task` to this tools/call request. */
  request: boolean;
  /** Requested retention window, in ms (omitted when not requesting). */
  ttlMs?: number;
  negotiation: TaskNegotiation;
  /** Human-readable reason, for observability. */
  reason: string;
}

/**
 * Decide whether THIS tools/call should be task-augmented.
 *
 * A task handle is only ever requested when the feature flag is on, the live
 * server advertised tools/call task support, and the tool itself declares
 * `execution.taskSupport` as `required` or `optional`. Tools that declare
 * `forbidden` — or declare nothing at all — keep classic synchronous behavior.
 */
export async function decideTaskAugmentation(
  client: Client | undefined,
  toolName: string,
): Promise<TaskAugmentationDecision> {
  const negotiation = getTaskNegotiation(client);
  if (!client || !negotiation.supportsToolsCall) {
    return {
      request: false,
      negotiation,
      reason: mcpTasksClientEnabled()
        ? 'server does not advertise tasks.requests.tools.call'
        : 'MCP Tasks client support disabled',
    };
  }

  const support = await getToolTaskSupport(client, toolName);
  if (support !== 'required' && support !== 'optional') {
    return {
      request: false,
      negotiation,
      reason: `tool declares taskSupport=${support ?? 'none'}`,
    };
  }

  const settings = await getMcpRemoteTaskSettings();
  return {
    request: true,
    ttlMs: settings.requestedTtlMs,
    negotiation,
    reason: `tool declares taskSupport=${support}`,
  };
}

/** Build the per-request task augmentation params fragment. */
export function buildTaskAugmentation(ttlMs?: number): { task: { ttl?: number } } {
  return { task: { ...(typeof ttlMs === 'number' && ttlMs > 0 ? { ttl: ttlMs } : {}) } };
}

interface RequestCapableClient {
  request: (req: unknown, schema?: unknown, opts?: unknown) => Promise<unknown>;
}

/**
 * Send a Tasks request. Kept on the generic `request()` seam so it works
 * identically for the v1 SDK client and the v2-beta client (betaClient.ts),
 * neither of which shares a typed Tasks helper surface.
 */
async function taskRequest(
  client: Client,
  method: string,
  taskId: string,
  schema: unknown,
  options?: { signal?: AbortSignal; timeout?: number },
): Promise<unknown> {
  return (client as unknown as RequestCapableClient).request(
    { method, params: { taskId } },
    schema,
    { ...(options?.signal ? { signal: options.signal } : {}), ...(options?.timeout ? { timeout: options.timeout } : {}) },
  );
}

export type TaskStatusOutcome =
  | { ok: true; task: McpTask }
  | { ok: false; reason: string };

/** `tasks/get` — validated task status. */
export async function fetchTaskStatus(
  client: Client,
  taskId: string,
  options?: { signal?: AbortSignal; timeout?: number },
): Promise<TaskStatusOutcome> {
  const raw = await taskRequest(client, MCP_TASK_METHODS.get, taskId, GetTaskResultSchema, options);
  const parsed = parseTaskStatusResult(raw);
  return parsed.ok ? { ok: true, task: parsed.task } : { ok: false, reason: parsed.reason };
}

/** `tasks/result` — the original request's result payload (e.g. CallToolResult). */
export async function fetchTaskPayload(
  client: Client,
  taskId: string,
  options?: { signal?: AbortSignal; timeout?: number },
): Promise<unknown> {
  return taskRequest(
    client,
    MCP_TASK_METHODS.result,
    taskId,
    GetTaskPayloadResultSchema,
    options,
  );
}

/**
 * `tasks/cancel` — cooperative cancellation. Never reuses the caller's aborted
 * signal (that would prevent the request from ever reaching the server) and is
 * deliberately best-effort: a failure is logged, not surfaced.
 */
export async function cancelRemoteTask(
  client: Client,
  taskId: string,
  timeoutMs = 10_000,
): Promise<TaskStatusOutcome | undefined> {
  try {
    const raw = await taskRequest(client, MCP_TASK_METHODS.cancel, taskId, CancelTaskResultSchema, {
      timeout: timeoutMs,
    });
    const parsed = parseTaskStatusResult(raw);
    return parsed.ok ? { ok: true, task: parsed.task } : { ok: false, reason: parsed.reason };
  } catch (error) {
    log.warn(`Best-effort tasks/cancel failed for task ${taskId}:`, error);
    return undefined;
  }
}
