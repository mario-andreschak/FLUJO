import { types } from 'node:util';
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
  const recordProperty = Object.getOwnPropertyDescriptor(state, 'executionModelStepOrdinals');
  const record = recordProperty && Object.hasOwn(recordProperty, 'value') && recordProperty.enumerable
    ? recordProperty.value : undefined;
  if (!isPlainRecord(record)) {
    throw new ExecutionExtensionError('execution_model_step_run_state_invalid');
  }
  const fields = Object.getOwnPropertyDescriptors(record);
  if (Reflect.ownKeys(fields).length !== 2 || !['logicalRunId', 'nextByNode'].every(key =>
      Object.hasOwn(fields, key) && Object.hasOwn(fields[key], 'value') && fields[key].enumerable)
      || fields.logicalRunId.value !== runId || !isPlainRecord(fields.nextByNode.value)) {
    throw new ExecutionExtensionError('execution_model_step_run_state_invalid');
  }
  // A getter or proxy can ignore the reservation and return the same ordinal
  // twice. Hidden keys disappear from JSON snapshots and replay after resume.
  // Inspect data descriptors before reading or mutating any cursor.
  const cursors = Object.getOwnPropertyDescriptors(fields.nextByNode.value);
  for (const nodeId of Reflect.ownKeys(cursors)) {
    try {
      assertExecutionModelStepNodeId(nodeId);
    } catch {
      throw new ExecutionExtensionError('execution_model_step_run_state_invalid');
    }
    const cursor = cursors[nodeId];
    const next = cursor.value;
    if (!Object.hasOwn(cursor, 'value') || !cursor.enumerable || !cursor.writable ||
        !Number.isSafeInteger(next) || next < 0 || next > MAX_EXECUTION_MODEL_STEP_ORDINAL + 1) {
      throw new ExecutionExtensionError('execution_model_step_run_state_invalid');
    }
  }
  return record as NonNullable<SharedState['executionModelStepOrdinals']>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !types.isProxy(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
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
