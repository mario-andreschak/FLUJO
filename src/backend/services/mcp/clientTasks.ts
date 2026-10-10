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
 *  3. map terminal states: `completed` → legacy `tasks/result` or modern inline payload, `failed` →
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
import { createHash } from 'node:crypto';
import { CallToolResultV2Schema, InputRequestV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
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
import { getElicitationContext, type ElicitationRunContext } from './elicitationContext';
import {
  clearTaskInputState,
  getTaskInputState,
  outstandingTaskInputKeys,
} from './taskInputRegistry';
import { getTasksExtensionSession, handleTasksInputRequest } from './tasksExtensionSession';

const log = createLogger('backend/services/mcp/clientTasks');

export interface ToolCallProgressLike {
  progress: number;
  total?: number;
  message?: string;
}

export interface RemoteTaskLifecycleOptions {
  generation?: McpTaskGeneration;
  assertCurrent?: () => void | Promise<void>;
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
  /** Host-captured run identity; never supplied by MCP arguments or UI metadata. */
  originatingInputContext?: ElicitationRunContext;
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
      ...(task.error ? { taskError: task.error } : {}),
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
    if (initialTask.generation && initialTask.generation !== generation) throw new Error('Remote task protocol generation changed');
  };
  const settings = await getMcpRemoteTaskSettings();
  const startedAt = Date.now();
  const taskTransport = client.transport;
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
    if (options.supportsCancel) { await assertCurrent(); await cancelRemoteTask(client, initialTask.taskId, 10_000, generation); }
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
  if (persist) {
    try { record = await createRemoteTaskRecord({
      remoteTaskId: initialTask.taskId,
      serverName,
      serverIdentity,
      toolName,
      ownership,
      status: initialTask.status,
      generation,
      statusMessage: initialTask.generation === '2026-07-28' ? undefined : initialTask.statusMessage,
      pollIntervalMs: basePollMs,
      ...(expiresAt !== undefined ? { expiresAt, ttlMs: expiresAt - startedAt } : {}),
    }); } catch (error) { log.warn('Remote MCP task persistence failed', error); }
    if (!record) {
      try { if (options.supportsCancel) { await assertCurrent(); await cancelRemoteTask(client, initialTask.taskId, 10_000, generation); } }
      finally { slot.release(); }
      return { success: false, error: 'Remote MCP task could not be recorded durably.',
        errorType: 'task-persistence-error', progressToken: initialTask.taskId, toolName };
    }
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
        if (taskTransport && client.transport !== taskTransport) return undefined;
        await assertCurrent();
        return cancelRemoteTask(client, initialTask.taskId, 10_000, generation);
      })();
    }
    return cancelPromise;
  };

  const onAbort = () => {
    void cancelOnce().catch(error => log.warn('MCP task cancellation failed', error));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const deadlineController = new AbortController();
  const lifetimeMs = Math.min(timeoutMs, expiresAt === undefined ? Infinity : Math.max(0, expiresAt - startedAt));
  const deadlineTimer = Number.isFinite(lifetimeMs) && lifetimeMs < 2_147_483_647
    ? setTimeout(() => deadlineController.abort(), lifetimeMs) : undefined;
  const connectionSignal = initialTask.generation === '2026-07-28' ? getTasksExtensionSession(client)?.signal : undefined;
  const pollSignal = AbortSignal.any([deadlineController.signal, ...(signal ? [signal] : []), ...(connectionSignal ? [connectionSignal] : [])]);
  const answeredInputKeys = new Map<string, string>();

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
      if (connectionSignal?.aborted || (taskTransport && client.transport !== taskTransport)) {
        // An unobserved remote outcome remains recoverable after a deliberate
        // reconnect. Do not mark it terminal or cancel through new authority.
        await patch({ diagnostic: 'transport-error', lastPolledAt: Date.now() });
        return { success: false, error: `The connection to '${serverName}' retired while task ${currentTask.taskId} was pending.`,
          errorType: 'task-transport-error', progressToken: currentTask.taskId, toolName };
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

      if (currentTask.generation === '2026-07-28' && currentTask.status === 'input_required' && currentTask.inputRequests) {
        inputRequiredSince ??= Date.now();
        const inputContext = getElicitationContext(serverName);
        if (!ownership.conversationId || inputContext?.conversationId !== ownership.conversationId ||
            (options.originatingInputContext && inputContext !== options.originatingInputContext)) {
          return await abandonInput({ action: 'abandon', error: `Task ${currentTask.taskId} has no matching attended conversation.`,
            errorType: 'task-input-required-unattended', diagnostic: 'input-required-unattended' });
        }
        const decision = evaluateInputRequired(serverName, currentTask.taskId, inputRequiredSince, settings.inputRequiredTimeoutMs);
        if (decision.action === 'abandon') return await abandonInput(decision);
        const extension = getTasksExtensionSession(client);
        try {
          if (!extension && !options.handleInputRequest) throw new Error('The modern MCP Tasks connection is no longer active');
          for (const [key, request] of Object.entries(currentTask.inputRequests)) {
            const digest = createHash('sha256').update(canonicalInput(request)).digest('hex');
            const previous = answeredInputKeys.get(key);
            if (previous && previous !== digest) throw new Error('MCP task reused an input key for different input');
            if (previous) continue;
            if (answeredInputKeys.size >= 32) throw new Error('MCP task exceeded the input exchange budget');
            const remaining = Math.max(1, settings.inputRequiredTimeoutMs - (Date.now() - inputRequiredSince));
            const inputController = new AbortController();
            const inputTimer = setTimeout(() => inputController.abort(), remaining);
            const inputSignal = AbortSignal.any([pollSignal, inputController.signal]);
            const inputMeta = request.params?._meta;
            const withRelatedTask = InputRequestV2Schema.parse({ ...request, params: { ...request.params,
              _meta: { ...(inputMeta && typeof inputMeta === 'object' && !Array.isArray(inputMeta) ? inputMeta : {}),
                'io.modelcontextprotocol/related-task': { taskId: currentTask.taskId } } } });
            try {
              await assertCurrent();
              const response = options.handleInputRequest
                ? await boundedInput(options.handleInputRequest(withRelatedTask, { signal: inputSignal, assertCurrent }), inputSignal)
                : await handleTasksInputRequest(client, withRelatedTask, inputSignal, ownership.conversationId);
              await assertCurrent();
              if (getElicitationContext(serverName) !== inputContext || inputContext.getUnattended() ||
                  (taskTransport && client.transport !== taskTransport)) {
                return await abandonInput({ action: 'abandon', error: `Task ${currentTask.taskId} attended input authority changed.`,
                  errorType: 'task-input-required-unattended', diagnostic: 'input-required-unattended' });
              }
              // Responses stay in this ephemeral request only; no response or
              // embedded prompt/schema/result enters the durable task record.
              const updateRemaining = Math.min(remaining, lifetimeMs - (Date.now() - startedAt), settings.inputRequiredTimeoutMs - (Date.now() - inputRequiredSince));
              if (updateRemaining <= 0) throw new Error('Task input deadline elapsed');
              await updateRemoteTask(client, currentTask.taskId, { [key]: response }, {
                generation, signal: inputSignal, timeout: Math.min(10_000, updateRemaining),
              });
              await assertCurrent();
              answeredInputKeys.set(key, digest);
            } finally { clearTimeout(inputTimer); inputController.abort(); }
          }
        } catch (error) {
          if (pollSignal.aborted) continue;
          if (Date.now() - inputRequiredSince >= settings.inputRequiredTimeoutMs) {
            return await abandonInput({ action: 'abandon', error: `Task ${currentTask.taskId} input deadline elapsed.`,
              errorType: 'task-input-timeout', diagnostic: 'input-required-unattended' });
          }
          await cancelOnce('protocol-invalid');
          await patch({ status: 'failed', diagnostic: 'protocol-invalid', errorMessage: 'MCP Tasks input exchange failed.' });
          return { success: false, error: `MCP Tasks input exchange failed: ${String(error)}`,
            errorType: 'task-protocol-invalid', progressToken: currentTask.taskId, toolName };
        }
      }

      try { await waitForPoll(Math.min(pollMs, Math.max(1, lifetimeMs - (Date.now() - startedAt))), pollSignal); }
      catch (error) { if (pollSignal.aborted) continue; throw error; }
      if (signal?.aborted) continue; // handled at the top of the loop
      if (deadlineController.signal.aborted) continue;

      let status: Awaited<ReturnType<typeof fetchTaskStatus>>;
      try {
        await assertCurrent();
        status = await fetchTaskStatus(client, currentTask.taskId, {
          timeout: Math.max(1, Math.min(pollMs * 4 + 10_000, lifetimeMs - (Date.now() - startedAt))),
          signal: pollSignal, generation,
        });
        transientFailures = 0;
        pollMs = basePollMs;
      } catch (error) {
        if (pollSignal.aborted) continue;
        // Transient transport/reconnect failure: bounded exponential backoff,
        // then fail closed WITHOUT losing the durable record.
        transientFailures++;
        await patch({ diagnostic: 'transport-error', lastPolledAt: Date.now() });
        if (transientFailures >= settings.maxTransientPollFailures) {
          await cancelOnce('transport-error');
          await patch({
            status: 'failed',
            diagnostic: 'transport-error',
            errorMessage: initialTask.generation === '2026-07-28'
              ? 'Remote MCP task polling failed.' : `tasks/get failed ${transientFailures} times: ${String(error)}`,
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
        statusMessage: currentTask.generation === '2026-07-28' ? undefined : currentTask.statusMessage,
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
        // Keep polling: answering the related elicitation is what advances the
        // task, and the poll loop observes the resulting status change.
      } else {
        inputRequiredSince = undefined;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    deadlineController.abort();
    signal?.removeEventListener('abort', onAbort);
    slot.release();
    clearTaskInputState(serverName, initialTask.taskId);
  }

  /** Map a terminal task to a FLUJO response, fetching the payload if needed. */
  async function finalize(task: McpTask): Promise<MCPServiceResponse> {
    await assertCurrent();
    pollSignal.throwIfAborted();
    if (task.generation === '2026-07-28' &&
        ((task.status === 'completed' && task.result === undefined) || (task.status === 'failed' && task.error === undefined))) {
      try {
        await assertCurrent();
        const detailed = await fetchTaskStatus(client, task.taskId, {
          signal: pollSignal, timeout: Math.max(1, Math.min(60_000, lifetimeMs - (Date.now() - startedAt))),
        });
        await assertCurrent();
        if (!detailed.ok || detailed.task.taskId !== task.taskId || detailed.task.generation !== generation || detailed.task.status !== task.status) throw new Error('Modern terminal task details are inconsistent');
        task = detailed.task;
      } catch {
        return { success: false, error: `Task ${task.taskId} terminal details could not be retrieved from '${serverName}'.`,
          errorType: 'task-result-unavailable', progressToken: task.taskId, toolName };
      }
    }
    if (task.status !== 'completed') {
      await patch({
        ...(record?.status === task.status ? {} : { status: task.status }),
        statusMessage: task.generation === '2026-07-28' ? undefined : task.statusMessage,
        ...(task.status === 'failed'
          ? { errorMessage: task.generation === '2026-07-28' ? 'Remote MCP task failed.' : task.statusMessage ?? 'Remote MCP task failed.' }
          : {}),
      });
      return terminalResponseFor(task, toolName);
    }

    if (task.generation === '2026-07-28') {
      const parsed = CallToolResultV2Schema.safeParse(task.result);
      if (!parsed.success || parsed.data.resultType !== 'complete') {
        await patch({ status: 'completed', resultRetrieved: false, diagnostic: 'protocol-invalid',
          errorMessage: 'Remote completed task returned an invalid tools/call result.' });
        return { success: false, error: `Task ${task.taskId} returned an invalid completed tool result.`,
          errorType: 'task-protocol-invalid', statusCode: 502, progressToken: task.taskId, toolName };
      }
      task = { ...task, result: parsed.data };
    }
    try {
      await assertCurrent();
      const payload = await fetchTaskPayload(client, task.taskId, {
        timeout: Math.max(1, Math.min(60_000, lifetimeMs - (Date.now() - startedAt))), signal: pollSignal, generation, terminalTask: task,
      });
      await assertCurrent();
      pollSignal.throwIfAborted();
      if (task.generation === '2026-07-28' && !payload) throw new Error('Modern completed task omitted its result');
      await patch({ ...(record?.status === 'completed' ? {} : { status: 'completed' as const }), resultRetrieved: true });
      onProgress?.({ progress: 100, message: `Task ${task.taskId}: completed` });
      return terminalResponseFor(task, toolName, payload);
    } catch (error) {
      await patch({
        ...(record?.status === 'completed' ? {} : { status: 'completed' as const }),
        resultRetrieved: false,
        errorMessage: task.generation === '2026-07-28' ? 'Remote MCP task result could not be retrieved.' : `tasks/result failed: ${String(error)}`,
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

  async function abandonInput(decision: Extract<InputRequiredDecision, { action: 'abandon' }>): Promise<MCPServiceResponse> {
    await cancelOnce(decision.diagnostic);
    await patch({ status: 'failed', diagnostic: decision.diagnostic, errorMessage: decision.error });
    return { success: false, error: decision.error, errorType: decision.errorType,
      progressToken: initialTask.taskId, toolName };
  }
}

async function boundedInput<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Task input cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function canonicalInput(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalInput(item)}`).join(',')}}`;
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
