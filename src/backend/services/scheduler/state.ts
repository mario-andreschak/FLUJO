import { saveItem, loadItem, clearItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { PlannedExecutionState } from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';

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

export async function deleteExecutionState(executionId: string): Promise<void> {
  await clearItem(stateKey(executionId));
}
