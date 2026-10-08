import { promises as fs } from 'fs';
import path from 'path';
import { saveItem, loadItem, clearItem } from '@/utils/storage/backend';
import { assertSafeCollectionId } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { RunRecord } from '@/shared/types/plannedExecution';
import { createLogger } from '@/utils/logger';
import {
  bindToCurrentWorkspace,
  getWorkspaceDataDir,
  workspaceCacheKey,
} from '@/utils/workspace';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import type { FlowRunEvent } from './flowRunEventBus';

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

/**
 * Write-ahead terminal publication outbox. A receipt is saved before its
 * terminal history row, then removed only after publication. Consequently a
 * crash can leave either no terminal row, or a recoverable pending receipt —
 * never a terminal row whose downstream event is unknowable.
 */
const TERMINAL_PUBLICATION_OUTBOX_KEY =
  'scheduler-terminal-publication-outbox' as StorageKey;
const TERMINAL_PUBLICATION_LOCK_ID = 'scheduler_terminal_publications';

export interface StableTerminalPublicationReceipt {
  id: string;
  executionId: string;
  runId: string;
  event: FlowRunEvent;
  /** Canonical terminal row used to repair receipt-before-history crashes. */
  record: RunRecord;
  createdAt: string;
}

interface StableTerminalPublicationOutbox {
  version: 1;
  pending: Record<string, StableTerminalPublicationReceipt>;
}

async function loadTerminalPublicationOutbox(): Promise<StableTerminalPublicationOutbox> {
  const stored = await loadItem<StableTerminalPublicationOutbox>(
    TERMINAL_PUBLICATION_OUTBOX_KEY,
    { version: 1, pending: {} },
  );
  return {
    version: 1,
    pending: stored?.version === 1 && stored.pending && typeof stored.pending === 'object'
      ? { ...stored.pending }
      : {},
  };
}

const runsKey = (executionId: string) =>
  `planned-execution-runs/${executionId}` as StorageKey;

const appendChains = new Map<string, Promise<unknown>>();
let runHistoryExecutionIdsOverride: readonly string[] | undefined;

function anonymizeRunRecord(
  record: RunRecord,
  personaId: string,
): { record: RunRecord; changed: boolean } {
  if (record.personaId !== personaId) return { record, changed: false };
  const archived = { ...record, personaArchived: true as const };
  delete archived.personaId;
  delete archived.activityId;
  delete archived.behaviorRevisionId;
  return { record: archived, changed: true };
}

async function listRunHistoryExecutionIds(): Promise<string[]> {
  if (runHistoryExecutionIdsOverride) {
    return [...new Set(runHistoryExecutionIdsOverride)].sort();
  }
  const directory = path.join(getWorkspaceDataDir(), 'db', 'planned-execution-runs');
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    if (entry.includes('.tmp.') || entry.includes('.corrupted.') || entry.endsWith('.bak')) continue;
    const id = entry.slice(0, -'.json'.length);
    assertSafeCollectionId(id);
    ids.push(id);
  }
  return ids;
}

/** Test seam for storage-mocked scheduler suites. */
export function _setRunHistoryExecutionIdsForTests(
  ids: readonly string[] | undefined,
): readonly string[] | undefined {
  const previous = runHistoryExecutionIdsOverride;
  runHistoryExecutionIdsOverride = ids;
  return previous;
}

export interface RunHistoryPersonaAnonymizationResult {
  histories: number;
  records: number;
  terminalReceipts: number;
}

/** Exact-match privacy erasure across every retained scheduler run history. */
export async function anonymizeRunHistoryPersonaAttribution(
  personaId: string,
): Promise<RunHistoryPersonaAnonymizationResult> {
  return bindToCurrentWorkspace(() => withPersonaRuntimeLock(
    TERMINAL_PUBLICATION_LOCK_ID,
    async (lock) => {
      const result: RunHistoryPersonaAnonymizationResult = {
        histories: 0,
        records: 0,
        terminalReceipts: 0,
      };
      for (const executionId of await listRunHistoryExecutionIds()) {
        const stored = await loadItem<unknown>(runsKey(executionId), []);
        if (!Array.isArray(stored)) {
          throw new Error(`Run history ${executionId} is not an array.`);
        }
        let changed = false;
        const records = (stored as RunRecord[]).map((record) => {
          const anonymized = anonymizeRunRecord(record, personaId);
          if (anonymized.changed) {
            changed = true;
            result.records += 1;
          }
          return anonymized.record;
        });
        if (!changed) continue;
        await lock.assertOwned();
        await saveItem(runsKey(executionId), records);
        result.histories += 1;
      }

      const outbox = await loadTerminalPublicationOutbox();
      let outboxChanged = false;
      for (const [id, receipt] of Object.entries(outbox.pending)) {
        const anonymized = anonymizeRunRecord(receipt.record, personaId);
        if (!anonymized.changed) continue;
        outbox.pending[id] = { ...receipt, record: anonymized.record };
        outboxChanged = true;
        result.terminalReceipts += 1;
      }
      if (outboxChanged) {
        await lock.assertOwned();
        await saveItem(TERMINAL_PUBLICATION_OUTBOX_KEY, outbox);
      }
      return result;
    },
  ))();
}

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
  const chainKey = workspaceCacheKey(executionId);
  const previous = appendChains.get(chainKey) ?? Promise.resolve();
  const append = bindToCurrentWorkspace(() => withPersonaRuntimeLock(
    TERMINAL_PUBLICATION_LOCK_ID,
    async (lock) => {
      const records = await loadRunRecords(executionId);
      records.push(record);
      const trimmed = records.slice(-MAX_RUN_RECORDS);
      await lock.assertOwned();
      await saveItem(runsKey(executionId), trimmed);
    },
  ));
  const run = previous
    .catch(() => { /* prior append's error surfaced to its own caller */ })
    .then(append);
  appendChains.set(chainKey, run);
  try {
    await run;
  } finally {
    if (appendChains.get(chainKey) === run) {
      appendChains.delete(chainKey);
    }
  }
}

export interface StableRunRecordUpsertResult {
  /** The one canonical history row for this stable delivery/run id. */
  record: RunRecord;
  /** True only when this call created the row rather than updating/reusing it. */
  inserted: boolean;
  /** True exactly once, when this run id first becomes publishably terminal. */
  firstTerminalTransition: boolean;
}

function isPublishableTerminal(record: RunRecord): boolean {
  return record.status === 'completed' || record.status === 'error';
}

/**
 * Persist one stable delivery as exactly one history row. Retries may refresh a
 * non-terminal row (for example `skipped` after an encryption lock, or
 * `needs_approval`) but the first completed/error row wins permanently. The
 * returned transition bit lets callers publish downstream terminal events only
 * once while legacy random-run-id appends keep their historical behavior.
 */
export async function upsertStableRunRecord(
  executionId: string,
  record: RunRecord,
  terminalPublication?: StableTerminalPublicationReceipt,
): Promise<StableRunRecordUpsertResult> {
  const chainKey = workspaceCacheKey(executionId);
  const previous = appendChains.get(chainKey) ?? Promise.resolve();
  let result: StableRunRecordUpsertResult | undefined;
  const upsert = bindToCurrentWorkspace(() => withPersonaRuntimeLock(
    TERMINAL_PUBLICATION_LOCK_ID,
    async (lock) => {
      const records = await loadRunRecords(executionId);
      const index = records.findIndex((candidate) => candidate.runId === record.runId);
      const existing = index < 0 ? undefined : records[index];
      if (existing && isPublishableTerminal(existing)) {
        result = {
          record: existing,
          inserted: false,
          firstTerminalTransition: false,
        };
        return;
      }

      const firstTerminalTransition = isPublishableTerminal(record);
      if (firstTerminalTransition && terminalPublication) {
        if (
          terminalPublication.executionId !== executionId
          || terminalPublication.runId !== record.runId
          || terminalPublication.event.runId !== record.runId
          || terminalPublication.record.runId !== record.runId
          || !isPublishableTerminal(terminalPublication.record)
          || JSON.stringify(terminalPublication.record) !== JSON.stringify(record)
          || !terminalPublication.event.deliveryId
        ) {
          throw new Error(`Invalid terminal publication receipt for ${record.runId}.`);
        }
        const outbox = await loadTerminalPublicationOutbox();
        const priorReceipt = outbox.pending[terminalPublication.id];
        if (priorReceipt && JSON.stringify(priorReceipt) !== JSON.stringify(terminalPublication)) {
          throw new Error(`Terminal publication receipt ${terminalPublication.id} conflicts.`);
        }
        if (!priorReceipt) {
          outbox.pending[terminalPublication.id] = terminalPublication;
          await lock.assertOwned();
          // Write-ahead barrier: this must settle before the terminal row.
          await saveItem(TERMINAL_PUBLICATION_OUTBOX_KEY, outbox);
        }
      }

      if (index < 0) records.push(record);
      else records[index] = record;
      await lock.assertOwned();
      await saveItem(
        runsKey(executionId),
        index < 0 ? records.slice(-MAX_RUN_RECORDS) : records,
      );
      result = {
        record,
        inserted: index < 0,
        firstTerminalTransition,
      };
    },
  ));
  const run = previous
    .catch(() => { /* prior write's error surfaced to its own caller */ })
    .then(upsert);
  appendChains.set(chainKey, run);
  try {
    await run;
  } finally {
    if (appendChains.get(chainKey) === run) {
      appendChains.delete(chainKey);
    }
  }
  if (!result) throw new Error(`Stable run history upsert did not settle for ${record.runId}.`);
  return result;
}

/**
 * Publish recoverable terminal receipts in creation order. Publication is
 * intentionally at-least-once: a crash after the synchronous bus publish but
 * before receipt removal replays the same event.deliveryId. Persona consumers
 * use that stable identity for mailbox deduplication.
 */
export async function drainStableTerminalPublications(
  publish: (event: FlowRunEvent) => void | Promise<void>,
): Promise<number> {
  return bindToCurrentWorkspace(() => withPersonaRuntimeLock(
    TERMINAL_PUBLICATION_LOCK_ID,
    async (lock) => {
      const outbox = await loadTerminalPublicationOutbox();
      const receipts = Object.values(outbox.pending)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      let published = 0;
      for (const receipt of receipts) {
        // A crash after the write-ahead receipt but before the terminal row
        // leaves an orphan pending receipt. Its canonical record repairs that
        // missing transition before publication, without a source retry.
        const records = await loadRunRecords(receipt.executionId);
        const terminal = records.find((candidate) => (
          candidate.runId === receipt.runId && isPublishableTerminal(candidate)
        ));
        if (!terminal) {
          if (
            receipt.record.runId !== receipt.runId
            || !isPublishableTerminal(receipt.record)
            || receipt.event.runId !== receipt.runId
          ) {
            throw new Error(`Corrupt terminal publication receipt ${receipt.id}.`);
          }
          const priorIndex = records.findIndex((candidate) => candidate.runId === receipt.runId);
          if (priorIndex < 0) records.push(receipt.record);
          else records[priorIndex] = receipt.record;
          await lock.assertOwned();
          await saveItem(runsKey(receipt.executionId), records.slice(-MAX_RUN_RECORDS));
        }

        await publish(receipt.event);
        delete outbox.pending[receipt.id];
        await lock.assertOwned();
        // Persist after EACH publish to minimize the duplicate replay window.
        await saveItem(TERMINAL_PUBLICATION_OUTBOX_KEY, outbox);
        published += 1;
      }
      return published;
    },
  ))();
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
  const chainKey = workspaceCacheKey(executionId);
  const previous = appendChains.get(chainKey) ?? Promise.resolve();
  let updated: RunRecord | null = null;
  const update = bindToCurrentWorkspace(() => withPersonaRuntimeLock(
    TERMINAL_PUBLICATION_LOCK_ID,
    async (lock) => {
      const records = await loadRunRecords(executionId);
      const index = records.findIndex(r => r.runId === runId);
      if (index < 0) {
        updated = null;
        return;
      }
      records[index] = { ...records[index], ...patch, runId };
      updated = records[index];
      await lock.assertOwned();
      await saveItem(runsKey(executionId), records);
    },
  ));
  const run = previous
    .catch(() => { /* prior write's error surfaced to its own caller */ })
    .then(update);
  appendChains.set(chainKey, run);
  try {
    await run;
  } finally {
    if (appendChains.get(chainKey) === run) {
      appendChains.delete(chainKey);
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
  await withPersonaRuntimeLock(TERMINAL_PUBLICATION_LOCK_ID, async (lock) => {
    const outbox = await loadTerminalPublicationOutbox();
    let changed = false;
    for (const [id, receipt] of Object.entries(outbox.pending)) {
      if (receipt.executionId === executionId) {
        delete outbox.pending[id];
        changed = true;
      }
    }
    if (changed) {
      await lock.assertOwned();
      await saveItem(TERMINAL_PUBLICATION_OUTBOX_KEY, outbox);
    }
    await lock.assertOwned();
    await clearItem(runsKey(executionId));
  });
}
