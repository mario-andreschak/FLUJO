/**
 * Bridge between MCP task `input_required` states and FLUJO's existing
 * elicitation UX (issue #404, plan step 5).
 *
 * PROTOCOL NOTE. The resolved SDK/spec (`@modelcontextprotocol/sdk` 1.30.0)
 * has no `tasks/update` method and no `inputRequests` array. A task that needs
 * input is expressed by the server issuing an ordinary related request —
 * `elicitation/create` (or `sampling/createMessage`) carrying
 * `_meta["io.modelcontextprotocol/related-task"] = { taskId }` — while the task
 * itself reports `status: "input_required"`. Answering that elicitation IS the
 * task update; the client then resumes `tasks/get`.
 *
 * This registry is the in-memory correlation between those two channels: it
 * records which elicitation ids are outstanding for a given task so the poll
 * loop can (a) report progress meaningfully, (b) persist the outstanding keys
 * (ids only — never the prompt, schema or the user's answer), and (c) make a
 * documented decision when nobody can answer.
 *
 * Deliberately process-memory (globalThis-backed, like elicitationRegistry):
 * a pending request cannot survive a restart because the transport request it
 * belongs to cannot either. Restart-safe state lives in the durable record.
 */

import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/mcp/taskInputRegistry');

export interface TaskInputState {
  /** Elicitation ids currently awaiting an answer for this task. */
  outstanding: Set<string>;
  /** Elicitation ids already answered (idempotency for repeat submissions). */
  answered: Set<string>;
  firstRequestedAt: number;
  lastRequestedAt: number;
}

const globalForRegistry = globalThis as unknown as {
  __flujoMcpTaskInputRegistry?: Map<string, TaskInputState>;
};
const registry: Map<string, TaskInputState> =
  globalForRegistry.__flujoMcpTaskInputRegistry ??
  (globalForRegistry.__flujoMcpTaskInputRegistry = new Map());

function keyOf(serverName: string, taskId: string): string {
  return `${serverName}::${taskId}`;
}

/** Record that a related elicitation was received for a task. */
export function noteTaskInputRequested(
  serverName: string,
  taskId: string,
  elicitationId: string,
): void {
  const key = keyOf(serverName, taskId);
  const now = Date.now();
  const state =
    registry.get(key) ??
    ({
      outstanding: new Set<string>(),
      answered: new Set<string>(),
      firstRequestedAt: now,
      lastRequestedAt: now,
    } satisfies TaskInputState);
  if (state.answered.has(elicitationId)) return; // idempotent re-delivery
  state.outstanding.add(elicitationId);
  state.lastRequestedAt = now;
  registry.set(key, state);
  log.info(
    `Task ${taskId} on ${serverName} requested input (elicitation ${elicitationId}); outstanding=${state.outstanding.size}`,
  );
}

/**
 * Record that a related elicitation was answered/declined/cancelled. Repeat
 * calls for the same id are no-ops, which makes duplicate UI submissions safe.
 */
export function noteTaskInputResolved(
  serverName: string,
  taskId: string,
  elicitationId: string,
  action: string,
): void {
  const key = keyOf(serverName, taskId);
  const state = registry.get(key);
  if (!state) return;
  if (!state.outstanding.delete(elicitationId) && state.answered.has(elicitationId)) return;
  state.answered.add(elicitationId);
  registry.set(key, state);
  log.info(
    `Task ${taskId} on ${serverName} input ${elicitationId} resolved with action=${action}; outstanding=${state.outstanding.size}`,
  );
}

export function getTaskInputState(
  serverName: string,
  taskId: string,
): TaskInputState | undefined {
  return registry.get(keyOf(serverName, taskId));
}

/** Outstanding elicitation ids for a task (safe to persist: ids only). */
export function outstandingTaskInputKeys(serverName: string, taskId: string): string[] {
  return [...(registry.get(keyOf(serverName, taskId))?.outstanding ?? [])];
}

/** Drop all correlation state for a task (terminal state / lifecycle exit). */
export function clearTaskInputState(serverName: string, taskId: string): void {
  registry.delete(keyOf(serverName, taskId));
}

/** Test helper. */
export function _clearAllTaskInputState(): void {
  registry.clear();
}
