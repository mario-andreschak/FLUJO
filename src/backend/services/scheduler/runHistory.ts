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

/**
 * Patch an existing run record in place, matched by runId (issue #115). Used to
 * transition a `needs_approval` record to its final completed/error outcome
 * once a paused headless run is resumed via the approval inbox. Read-modify-
 * write, chained per execution id (shares the append chain so it can't
 * interleave with a concurrent append). Returns the patched record, or null if
 * no record with that runId exists.
 */
export async function updateRunRecord(
  executionId: string,
  runId: string,
  patch: Partial<RunRecord>
): Promise<RunRecord | null> {
  const previous = appendChains.get(executionId) ?? Promise.resolve();
  let updated: RunRecord | null = null;
  const run = previous
    .catch(() => { /* prior write's error surfaced to its own caller */ })
    .then(async () => {
      const records = await loadRunRecords(executionId);
      const index = records.findIndex(r => r.runId === runId);
      if (index < 0) {
        updated = null;
        return;
      }
      records[index] = { ...records[index], ...patch, runId };
      updated = records[index];
      await saveItem(runsKey(executionId), records);
    });
  appendChains.set(executionId, run);
  try {
    await run;
  } finally {
    if (appendChains.get(executionId) === run) {
      appendChains.delete(executionId);
    }
  }
  return updated;
}

/** Most recent run, or null. */
export async function loadLastRunRecord(executionId: string): Promise<RunRecord | null> {
  const records = await loadRunRecords(executionId);
  return records.length > 0 ? records[records.length - 1] : null;
}

export async function deleteRunHistory(executionId: string): Promise<void> {
  await clearItem(runsKey(executionId));
}
