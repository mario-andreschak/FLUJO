import {
  assertExecutionModelStepNodeId,
  ExecutionExtensionError,
  MAX_EXECUTION_MODEL_STEP_ORDINAL,
} from '@/backend/execution/extensions';
import type { SharedState } from './types';

function requireRunId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ExecutionExtensionError('execution_model_step_run_required');
  }
  return value;
}

function checkedOrdinals(state: SharedState, runId: string): NonNullable<SharedState['executionModelStepOrdinals']> {
  const record = state.executionModelStepOrdinals;
  const nextByNode = record?.nextByNode;
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(record)) ||
      record.logicalRunId !== runId || !nextByNode ||
      typeof nextByNode !== 'object' || Array.isArray(nextByNode) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(nextByNode))) {
    throw new ExecutionExtensionError('execution_model_step_run_state_invalid');
  }
  for (const [nodeId, next] of Object.entries(nextByNode)) {
    try {
      assertExecutionModelStepNodeId(nodeId);
    } catch {
      throw new ExecutionExtensionError('execution_model_step_run_state_invalid');
    }
    if (!Number.isSafeInteger(next) || next < 0 || next > MAX_EXECUTION_MODEL_STEP_ORDINAL + 1) {
      throw new ExecutionExtensionError('execution_model_step_run_state_invalid');
    }
  }
  return record;
}

/** Bind a durable counter to the logical run. A same-id resume must bring its
 * saved counter; silently recreating one could replay an already issued slot. */
export function bindExecutionModelStepOrdinals(state: SharedState, previousRunId: string | undefined): void {
  const runId = requireRunId(state.logicalRunId);
  if (previousRunId !== runId) {
    state.executionModelStepOrdinals = { logicalRunId: runId, nextByNode: {} };
    return;
  }
  checkedOrdinals(state, runId);
}

/** Reserve before asking the owner. Denial or unknown outcome never rolls back. */
export function takeExecutionModelStepOrdinal(state: SharedState, nodeId: string, preparedRunId: string | undefined): number {
  assertExecutionModelStepNodeId(nodeId);
  const runId = requireRunId(preparedRunId);
  if (state.logicalRunId !== runId) {
    throw new ExecutionExtensionError('execution_model_step_run_state_invalid');
  }
  const record = checkedOrdinals(state, runId);
  const next = Object.hasOwn(record.nextByNode, nodeId) ? record.nextByNode[nodeId] : 0;
  if (next > MAX_EXECUTION_MODEL_STEP_ORDINAL) {
    throw new ExecutionExtensionError('execution_model_step_slot_exhausted');
  }
  record.nextByNode[nodeId] = next + 1;
  return next;
}
