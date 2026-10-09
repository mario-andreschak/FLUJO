/**
 * Client-side MCP task lifecycle (issue #404, plan steps 4 & 5).
 *
 * `callTool()` stays responsible for argument normalization, audience checks,
 * timeout/progress wiring and classic result mapping; everything that happens
 * *after* a validated `CreateTaskResult` lives here:
 *
 *  1. persist a durable, ownership-scoped record BEFORE the first follow-up
 *     request (so a crash can never lose a live remote task);
 *  2. poll `tasks/get` on the server-suggested interval, clamped to FLUJO's
 *     documented bounds and additionally constrained by the caller timeout, the
 *     abort signal and the task TTL;
 *  3. map terminal states: `completed` → `tasks/result` payload, `failed` →
 *     the server's structured failure text, `cancelled` → FLUJO's distinct
 *     cancelled response;
 *  4. handle `input_required` through the attended-run elicitation UX, with a
 *     documented policy for unattended runs and expiry;
 *  5. send `tasks/cancel` at most once on abort/timeout/expiry and stop the
 *     loop deterministically. Cancellation is cooperative: a terminal result
 *     that lands first wins (terminal records are immutable).
 *
 * Task creation is never retried after an ambiguous transport failure — the
 * resolved protocol has no idempotency key for `tools/call`, so a retry could
 * duplicate non-idempotent work. Only polling is resumable.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLogger } from '@/utils/logger';
import { sleep } from '@/backend/utils/sleep';
import type { MCPServiceResponse } from '@/shared/types/mcp/mcp';
import {
  clampPollIntervalMs,
  computeTaskExpiresAt,
  isTerminalMcpTaskStatus,
  type McpTask,
  type McpTaskGeneration,
  type McpTaskInputRequest,
} from '@/shared/types/mcp/tasks';
import type {
  McpRemoteTaskDiagnostic,
  McpRemoteTaskOwnership,
  McpRemoteTaskRecord,
} from '@/shared/types/mcp/taskRecords';
import {
  acquirePollSlot,
  createRemoteTaskRecord,
  getMcpRemoteTaskSettings,
  patchRemoteTaskRecord,
} from './remoteTaskStore';
import { cancelRemoteTask, fetchTaskPayload, fetchTaskStatus, updateRemoteTask } from './tasksProtocol';
import { getElicitationContext } from './elicitationContext';
import {
  clearTaskInputState,
  getTaskInputState,
  outstandingTaskInputKeys,
} from './taskInputRegistry';

const log = createLogger('backend/services/mcp/clientTasks');

/** Bound even an input implementation that fails to settle after cancellation. */
async function boundedInput(pending: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Task input expired or cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export interface ToolCallProgressLike {
  progress: number;
  total?: number;
  message?: string;
}

export interface RemoteTaskLifecycleOptions {
  generation?: McpTaskGeneration;
  /** Recheck caller authority, live client and immutable server identity before I/O. */
  assertCurrent?: () => void | Promise<void>;
  /** Existing per-client, policy-checked attended input bridge. */
  handleInputRequest?: (request: McpTaskInputRequest, options: { signal: AbortSignal; assertCurrent: () => Promise<void> }) => Promise<unknown>;
  client: Client;
  serverName: string;
  serverIdentity: string;
  toolName: string;
  args?: Record<string, unknown>;
  /** The already-validated task handle from the CreateTaskResult. */
  task: McpTask;
  /** Caller timeout in ms (SDK scale; the ceiling means "no timeout"). */
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: ToolCallProgressLike) => void;
  ownership: McpRemoteTaskOwnership;
  /** False only when durable persistence is unavailable (see callers). */
  persist: boolean;
  supportsCancel: boolean;
}

function terminalResponseFor(
  task: McpTask,
  toolName: string,
  payload?: unknown,
): MCPServiceResponse {
  if (task.status === 'completed') {
    return { success: true, data: payload, progressToken: task.taskId };
  }
  if (task.status === 'failed') {
    return {
      success: false,
      error: task.error?.message ?? task.statusMessage ?? `Task ${task.taskId} failed`,
      ...(task.error ? { data: task.error } : {}),
      errorType: 'task-failed',
      progressToken: task.taskId,
      toolName,
    };
  }
  return {
    success: false,
    error:
      task.statusMessage ??
      `Tool '${toolName}' task ${task.taskId} was cancelled by the server.`,
    errorType: 'cancelled',
    progressToken: task.taskId,
    toolName,
  };
}

/** Run the full poll lifecycle for a task returned by tools/call. */
export async function runRemoteTaskLifecycle(
  options: RemoteTaskLifecycleOptions,
): Promise<MCPServiceResponse> {
  const {
    client,
    serverName,
    serverIdentity,
    toolName,
    task: initialTask,
    timeoutMs,
    signal,
    onProgress,
    ownership,
    persist,
  } = options;
  const generation = options.generation ?? initialTask.generation ?? '2025-11-25';
  const assertCurrent = async () => {
    await options.assertCurrent?.();
    if (initialTask.generation && initialTask.generation !== generation) {
      throw new Error('Remote task protocol generation changed');
    }
  };

  const settings = await getMcpRemoteTaskSettings();
  const startedAt = Date.now();
  const basePollMs = clampPollIntervalMs(initialTask.pollInterval, {
    minMs: settings.minPollIntervalMs,
    maxMs: settings.maxPollIntervalMs,
    defaultMs: settings.defaultPollIntervalMs,
  });
  const expiresAt = computeTaskExpiresAt(initialTask, startedAt, settings.fallbackTtlMs);

  log.info(
    `Tool ${toolName} on ${serverName} returned task ${initialTask.taskId} (status=${initialTask.status}, poll=${basePollMs}ms, expiresAt=${expiresAt ?? 'none'})`,
  );
  onProgress?.({
    progress: 0,
    message: `Task ${initialTask.taskId} created (${initialTask.status})`,
  });

  // Bounded poll concurrency (global + per server). Failing closed here is
  // preferable to a poll storm; the remote task is cancelled best-effort.
  const slot = await acquirePollSlot(serverName);
  if (!slot) {
    log.warn(
      `Refusing to poll task ${initialTask.taskId}: poll concurrency limit reached for ${serverName}`,
    );
    if (options.supportsCancel) {
      await assertCurrent();
      await cancelRemoteTask(client, initialTask.taskId, 10_000, generation);
    }
    return {
      success: false,
      error: `Too many concurrent MCP tasks are being polled; task ${initialTask.taskId} was not started.`,
      errorType: 'task-poll-limit',
      progressToken: initialTask.taskId,
      toolName,
    };
  }

  // Durable record BEFORE any follow-up request.
  let record: McpRemoteTaskRecord | null = null;
  try {
    if (persist) record = await createRemoteTaskRecord({
      remoteTaskId: initialTask.taskId,
      serverName,
      serverIdentity,
      generation,
      toolName,
      ownership,
      status: initialTask.status,
      statusMessage: initialTask.statusMessage,
      pollIntervalMs: basePollMs,
      ...(expiresAt !== undefined ? { expiresAt, ttlMs: expiresAt - startedAt } : {}),
    });
  } catch (error) {
    slot.release();
    throw error;
  }

  const patch = async (
    update: Parameters<typeof patchRemoteTaskRecord>[1],
  ): Promise<void> => {
    if (!record) return;
    const next = await patchRemoteTaskRecord(record.recordId, update);
    if (next) record = next;
  };

  let cancelPromise: Promise<unknown> | undefined;
  const cancelOnce = (diagnostic?: McpRemoteTaskDiagnostic): Promise<unknown> => {
    if (!cancelPromise) {
      cancelPromise = (async () => {
        await patch({ cancelRequestedAt: Date.now(), ...(diagnostic ? { diagnostic } : {}) });
        if (!options.supportsCancel) {
          log.warn(
            `Server ${serverName} does not advertise tasks.cancel; skipping cancellation of ${initialTask.taskId}`,
          );
          return undefined;
        }
        await assertCurrent();
        return cancelRemoteTask(client, initialTask.taskId, 10_000, generation);
      })();
    }
    return cancelPromise;
  };

  const onAbort = () => {
    void cancelOnce().catch(error => log.warn('Remote task cancellation stopped', error));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal?.aborted) {
      await cancelOnce();
      return { success: false, error: 'Remote task caller was cancelled.', errorType: 'cancelled', toolName };
    }
    // A server may hand back an already-terminal task.
    if (isTerminalMcpTaskStatus(initialTask.status)) {
      return await finalize(initialTask);
    }

    let currentTask = initialTask;
    let transientFailures = 0;
    let pollMs = basePollMs;
    let inputRequiredSince: number | undefined;
    let pollCount = 0;
    const answeredInputKeys = new Set<string>();

    while (true) {
      if (signal?.aborted) {
        await cancelOnce();
        await patch({ status: 'cancelled' });
        return {
          success: false,
          error: `Tool '${toolName}' task ${currentTask.taskId} was cancelled.`,
          errorType: 'cancelled',
          progressToken: currentTask.taskId,
          toolName,
        };
      }

      const now = Date.now();
      if (expiresAt !== undefined && now >= expiresAt) {
        await cancelOnce('expired');
        await patch({
          status: 'failed',
          diagnostic: 'expired',
          errorMessage: 'Remote MCP task expired before completing.',
        });
        return {
          success: false,
          error: `Task ${currentTask.taskId} expired before completing.`,
          errorType: 'task-expired',
          progressToken: currentTask.taskId,
          toolName,
        };
      }
      if (now - startedAt >= timeoutMs) {
        await cancelOnce();
        await patch({
          status: 'failed',
          errorMessage: 'Caller timeout elapsed while polling the remote MCP task.',
        });
        const timeoutSeconds = Math.round(timeoutMs / 1000);
        return {
          success: false,
          error: `Tool execution timed out after ${timeoutSeconds} seconds`,
          errorType: 'timeout',
          timeout: timeoutSeconds,
          statusCode: 408,
          progressToken: currentTask.taskId,
          toolName,
        };
      }

      await sleep(pollMs);
      if (signal?.aborted) continue; // handled at the top of the loop

      let status: Awaited<ReturnType<typeof fetchTaskStatus>>;
      try {
        await assertCurrent();
        status = await fetchTaskStatus(client, currentTask.taskId, {
          timeout: Math.min(pollMs * 4 + 10_000, timeoutMs),
          signal,
          generation,
        });
        transientFailures = 0;
        pollMs = basePollMs;
      } catch (error) {
        // Transient transport/reconnect failure: bounded exponential backoff,
        // then fail closed WITHOUT losing the durable record.
        transientFailures++;
        await patch({ diagnostic: 'transport-error', lastPolledAt: Date.now() });
        if (transientFailures >= settings.maxTransientPollFailures) {
          await cancelOnce('transport-error');
          await patch({
            status: 'failed',
            diagnostic: 'transport-error',
            errorMessage: `tasks/get failed ${transientFailures} times: ${String(error)}`,
          });
          return {
            success: false,
            error: `Lost contact with '${serverName}' while polling task ${currentTask.taskId}.`,
            errorType: 'task-transport-error',
            progressToken: currentTask.taskId,
            toolName,
          };
        }
        pollMs = clampPollIntervalMs(pollMs * 2, {
          minMs: settings.minPollIntervalMs,
          maxMs: settings.maxPollIntervalMs,
          defaultMs: settings.defaultPollIntervalMs,
        });
        log.warn(
          `Transient tasks/get failure ${transientFailures}/${settings.maxTransientPollFailures} for ${currentTask.taskId}; backing off to ${pollMs}ms`,
        );
        continue;
      }

      if (!status.ok) {
        // A malformed status response is a protocol violation: fail closed.
        await cancelOnce('protocol-invalid');
        await patch({
          status: 'failed',
          diagnostic: 'protocol-invalid',
          errorMessage: `Invalid tasks/get result: ${status.reason}`,
        });
        return {
          success: false,
          error: `Server '${serverName}' returned an invalid task status: ${status.reason}`,
          errorType: 'task-protocol-invalid',
          progressToken: currentTask.taskId,
          toolName,
        };
      }

      await assertCurrent();

      if (status.task.taskId !== initialTask.taskId || (status.task.generation ?? '2025-11-25') !== generation) {
        await cancelOnce('protocol-invalid');
        await patch({ status: 'failed', diagnostic: 'protocol-invalid', errorMessage: 'Task identity or protocol generation changed in tasks/get.' });
        return { success: false, error: 'Remote task identity changed.', errorType: 'task-protocol-invalid', toolName };
      }
      currentTask = status.task;
      pollCount++;
      const elapsed = Date.now() - startedAt;
      await patch({
        status: currentTask.status,
        statusMessage: currentTask.statusMessage,
        lastPolledAt: Date.now(),
        nextPollAt: Date.now() + pollMs,
        pollCount,
        outstandingInputKeys: outstandingTaskInputKeys(serverName, currentTask.taskId),
      });

      onProgress?.({
        progress:
          currentTask.status === 'completed' ? 100 : Math.min(99, Math.round(elapsed / 1000)),
        message: `Task ${currentTask.taskId}: ${currentTask.status}${
          currentTask.statusMessage ? ` — ${currentTask.statusMessage}` : ''
        }`,
      });

      if (isTerminalMcpTaskStatus(currentTask.status)) {
        return await finalize(currentTask);
      }

      if (currentTask.status === 'input_required') {
        inputRequiredSince ??= Date.now();
        const decision = evaluateInputRequired(
          serverName,
          currentTask.taskId,
          inputRequiredSince,
          settings.inputRequiredTimeoutMs,
        );
        if (decision.action === 'abandon') {
          await cancelOnce(decision.diagnostic);
          await patch({
            status: 'failed',
            diagnostic: decision.diagnostic,
            errorMessage: decision.error,
          });
          return {
            success: false,
            error: decision.error,
            errorType: decision.errorType,
            progressToken: currentTask.taskId,
            toolName,
          };
        }
        if (generation === '2026-07-28' && currentTask.inputRequests) {
          const ctx = getElicitationContext(serverName);
          if (!options.handleInputRequest || !ownership.conversationId || ctx?.conversationId !== ownership.conversationId) {
            await cancelOnce('input-required-unattended');
            return { success: false, error: 'The originating attended run cannot answer task input.', errorType: 'task-input-required-unattended', toolName };
          }
          const keys = Object.keys(currentTask.inputRequests).filter(key => !answeredInputKeys.has(key));
          if (answeredInputKeys.size + keys.length > 32) {
            await cancelOnce('protocol-invalid');
            return { success: false, error: 'Task input request limit exceeded.', errorType: 'task-protocol-invalid', toolName };
          }
          const controller = new AbortController();
          const abortInput = () => controller.abort();
          signal?.addEventListener('abort', abortInput, { once: true });
          const remaining = Math.max(1, Math.min(settings.inputRequiredTimeoutMs - (Date.now() - inputRequiredSince), timeoutMs - (Date.now() - startedAt), expiresAt === undefined ? Infinity : expiresAt - Date.now()));
          const timer = setTimeout(abortInput, remaining);
          try {
            const responses: Record<string, unknown> = Object.create(null);
            for (const key of keys) {
              await assertCurrent();
              if (signal?.aborted || controller.signal.aborted) throw new Error('Task input expired or cancelled');
              responses[key] = await boundedInput(options.handleInputRequest(currentTask.inputRequests[key], { signal: controller.signal, assertCurrent }), controller.signal);
            }
            await assertCurrent();
            if (signal?.aborted || controller.signal.aborted) throw new Error('Task input expired or cancelled');
            const updateRemaining = Math.min(settings.inputRequiredTimeoutMs - (Date.now() - inputRequiredSince), timeoutMs - (Date.now() - startedAt), expiresAt === undefined ? Infinity : expiresAt - Date.now());
            if (updateRemaining <= 0) throw new Error('Task input deadline elapsed');
            if (keys.length) await updateRemoteTask(client, currentTask.taskId, responses, { generation, signal: controller.signal, timeout: Math.min(30_000, updateRemaining) });
            await assertCurrent();
            keys.forEach(key => answeredInputKeys.add(key));
            await patch({ outstandingInputKeys: Object.keys(currentTask.inputRequests).filter(key => !answeredInputKeys.has(key)) });
          } catch (error) {
            await cancelOnce('input-required-unattended');
            await patch({ status: 'failed', diagnostic: 'input-required-unattended', errorMessage: String(error) });
            return { success: false, error: 'Task input could not be answered by the originating run.', errorType: signal?.aborted ? 'cancelled' : 'task-input-timeout', toolName };
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abortInput);
            controller.abort();
          }
        }
        // Keep polling: answering the related elicitation is what advances the
        // task, and the poll loop observes the resulting status change.
      } else {
        inputRequiredSince = undefined;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    slot.release();
    clearTaskInputState(serverName, initialTask.taskId);
  }

  /** Map a terminal task to a FLUJO response, fetching the payload if needed. */
  async function finalize(task: McpTask): Promise<MCPServiceResponse> {
    if (task.status !== 'completed') {
      await patch({
        ...(record?.status === task.status ? {} : { status: task.status }),
        statusMessage: task.statusMessage,
        ...(task.status === 'failed'
          ? { errorMessage: task.statusMessage ?? 'Remote MCP task failed.' }
          : {}),
      });
      return terminalResponseFor(task, toolName);
    }

    try {
      await assertCurrent();
      const payload = await fetchTaskPayload(client, task.taskId, {
        timeout: Math.min(60_000, timeoutMs),
        generation,
        terminalTask: task,
        signal,
      });
      await assertCurrent();
      if (signal?.aborted) throw new Error('Task result caller was cancelled');
      await patch({ ...(record?.status === 'completed' ? {} : { status: 'completed' as const }), resultRetrieved: true });
      onProgress?.({ progress: 100, message: `Task ${task.taskId}: completed` });
      return terminalResponseFor(task, toolName, payload);
    } catch (error) {
      await patch({
        ...(record?.status === 'completed' ? {} : { status: 'completed' as const }),
        resultRetrieved: false,
        errorMessage: `tasks/result failed: ${String(error)}`,
      });
      return {
        success: false,
        error: `Task ${task.taskId} completed but its result could not be retrieved from '${serverName}'.`,
        errorType: 'task-result-unavailable',
        progressToken: task.taskId,
        toolName,
      };
    }
  }
}

type InputRequiredDecision =
  | { action: 'wait' }
  | {
      action: 'abandon';
      error: string;
      errorType: string;
      diagnostic: McpRemoteTaskDiagnostic;
    };

/**
 * Documented `input_required` policy. FLUJO only waits for human input inside an
 * ATTENDED run: outside one (no active context, an unattended run, or no UI
 * able to answer) the task is cancelled instead of being polled forever. A task
 * that stays in `input_required` past the configured window is also abandoned.
 */
export function evaluateInputRequired(
  serverName: string,
  taskId: string,
  since: number,
  timeoutMs: number,
  now = Date.now(),
): InputRequiredDecision {
  const ctx = getElicitationContext(serverName);
  const inputState = getTaskInputState(serverName, taskId);

  if (!ctx) {
    return {
      action: 'abandon',
      error: `Task ${taskId} on '${serverName}' requires input, but no attended run is available to answer it.`,
      errorType: 'task-input-required-unattended',
      diagnostic: 'input-required-unattended',
    };
  }
  if (ctx.getUnattended()) {
    return {
      action: 'abandon',
      error: `Task ${taskId} on '${serverName}' requires input, but the run is unattended.`,
      errorType: 'task-input-required-unattended',
      diagnostic: 'input-required-unattended',
    };
  }
  if (now - since >= timeoutMs) {
    return {
      action: 'abandon',
      error: `Task ${taskId} on '${serverName}' was waiting for input for longer than the configured window (${Math.round(
        timeoutMs / 1000,
      )}s)${inputState ? `; ${inputState.outstanding.size} request(s) unanswered` : ''}.`,
      errorType: 'task-input-timeout',
      diagnostic: 'input-required-unattended',
    };
  }
  return { action: 'wait' };
}
