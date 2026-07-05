import { saveItem, loadItem, clearItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { RunRecord } from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/scheduler/runHistory');

/**
 * Per-execution run history: db/planned-execution-runs/<id>.json, a ring
 * buffer of the newest MAX_RUN_RECORDS records (oldest first).
 *
 * Uses the storage chokepoint with a runtime-cast key, the same idiom as
 * conversations/<id>. saveItem serializes same-key WRITES, but append is a
 * read-modify-write, so appends are additionally chained per execution id.
 */
const MAX_RUN_RECORDS = 100;

const runsKey = (executionId: string) =>
  `planned-execution-runs/${executionId}` as StorageKey;

const appendChains = new Map<string, Promise<unknown>>();

export async function loadRunRecords(executionId: string): Promise<RunRecord[]> {
  try {
    return await loadItem<RunRecord[]>(runsKey(executionId), []);
  } catch (error) {
    // A corrupt history file must never break the scheduler or the UI list.
    log.error(`Failed to load run history for ${executionId}:`, error);
    return [];
  }
}

export async function appendRunRecord(
  executionId: string,
  record: RunRecord
): Promise<void> {
  const previous = appendChains.get(executionId) ?? Promise.resolve();
  const run = previous
    .catch(() => { /* prior append's error surfaced to its own caller */ })
    .then(async () => {
      const records = await loadRunRecords(executionId);
      records.push(record);
      const trimmed = records.slice(-MAX_RUN_RECORDS);
      await saveItem(runsKey(executionId), trimmed);
    });
  appendChains.set(executionId, run);
  try {
    await run;
  } finally {
    if (appendChains.get(executionId) === run) {
      appendChains.delete(executionId);
    }
  }
}

/** Most recent run, or null. */
export async function loadLastRunRecord(executionId: string): Promise<RunRecord | null> {
  const records = await loadRunRecords(executionId);
  return records.length > 0 ? records[records.length - 1] : null;
}

export async function deleteRunHistory(executionId: string): Promise<void> {
  await clearItem(runsKey(executionId));
}
