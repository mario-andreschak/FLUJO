import { saveItem, loadItem, clearItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { PlannedExecutionState } from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';
import { createHash } from 'crypto';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';

const log = createLogger('backend/services/scheduler/state');

/**
 * Per-execution mutable trigger state (catch-up timestamp, poll cursors):
 * db/planned-execution-state/<id>.json. Kept separate from the config file so
 * every fire/poll doesn't rewrite db/planned_executions.json.
 */
const stateKey = (executionId: string) =>
  `planned-execution-state/${executionId}` as StorageKey;

export async function loadExecutionState(
  executionId: string
): Promise<PlannedExecutionState> {
  try {
    return await loadItem<PlannedExecutionState>(stateKey(executionId), {});
  } catch (error) {
    // Trigger state is reconstructible (worst case: one duplicate/missed
    // catch-up or a re-primed poll cursor) — never let it break arming.
    log.error(`Failed to load trigger state for ${executionId}:`, error);
    return {};
  }
}

export async function saveExecutionState(
  executionId: string,
  state: PlannedExecutionState
): Promise<void> {
  await saveItem(stateKey(executionId), state);
}

/**
 * Cross-process monotonic schedule cursor advance. Overlapping occurrences may
 * finish admission out of order; an older callback can never move the durable
 * catch-up baseline backwards.
 */
export async function advanceLastScheduledFireAt(
  executionId: string,
  candidate: string,
): Promise<PlannedExecutionState> {
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(candidateMs)) {
    throw new TypeError(`Invalid scheduled occurrence timestamp ${JSON.stringify(candidate)}.`);
  }
  const lockId = `scheduler_state_${createHash('sha256')
    .update(executionId)
    .digest('hex')
    .slice(0, 40)}`;
  return withPersonaRuntimeLock(lockId, async (lock) => {
    const current = await loadExecutionState(executionId);
    const currentMs = current.lastScheduledFireAt
      ? Date.parse(current.lastScheduledFireAt)
      : Number.NEGATIVE_INFINITY;
    if (Number.isFinite(currentMs) && currentMs >= candidateMs) return current;
    const updated = { ...current, lastScheduledFireAt: new Date(candidateMs).toISOString() };
    await lock.assertOwned();
    await saveExecutionState(executionId, updated);
    return updated;
  });
}

export async function deleteExecutionState(executionId: string): Promise<void> {
  await clearItem(stateKey(executionId));
}
