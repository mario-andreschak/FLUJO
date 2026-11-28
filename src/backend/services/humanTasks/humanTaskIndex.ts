import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { bindToCurrentWorkspace, getCurrentWorkspace } from '@/utils/workspace';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { retryTransientFileOperation } from '@/utils/transientFileRetry';
import type { HumanOutcome, HumanStepMode } from '@/utils/shared/humanStep';

const log = createLogger('backend/services/humanTasks/humanTaskIndex');

/**
 * The list of Human steps (#1095): which ones wait, and which finished lately.
 *
 * It holds ids, titles and times only, never the content shown to the person or the
 * answer. The conversation state is the source of truth. This list only makes waiting
 * steps easy to find without reading every conversation, and it repairs itself: the
 * list route drops an entry whose conversation no longer waits for it, and finished
 * entries are forgotten after `FINISHED_RETENTION_MS`.
 */
export type HumanTaskStatus = 'waiting' | 'decided' | 'applied' | 'cancelled';

export interface HumanTaskIndexEntry {
  requestId: string;
  conversationId: string;
  flowId?: string;
  nodeId: string;
  title: string;
  mode: HumanStepMode;
  createdAt: string;
  expiresAt: string;
  status: HumanTaskStatus;
  outcome?: HumanOutcome;
  decisionId?: string;
  decidedAt?: string;
  finishedAt?: string;
}

type IndexFile = Record<string, HumanTaskIndexEntry>;

const KEY = StorageKey.HUMAN_TASKS;
const LOCK_ID = 'human_tasks_index';
/** A receipt stays readable this long after its step finished, then the entry goes. */
export const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const writeChains = new Map<string, Promise<unknown>>();

/** Read the list. A read that fails throws, so a writer never replaces the list with an empty one. */
async function loadAll(): Promise<IndexFile> {
  const file = await retryTransientFileOperation(() => loadItem<IndexFile>(KEY, {}), { label: 'human-task-index-read' });
  return file && typeof file === 'object' ? file : {};
}

async function readForCaller(): Promise<IndexFile> {
  try {
    return await loadAll();
  } catch (error) {
    log.error('Could not read the Human step list:', error);
    return {};
  }
}

/** Change the list under the workspace's write chain and file lock, so writers never clobber each other. */
async function mutate(change: (file: IndexFile) => boolean): Promise<void> {
  const workspace = getCurrentWorkspace();
  const write = bindToCurrentWorkspace(async () => {
    await withPersonaRuntimeLock(LOCK_ID, async (lock) => {
      const file = await loadAll();
      if (!change(file)) return;
      await lock.assertOwned();
      await retryTransientFileOperation(() => saveItem(KEY, file), { label: 'human-task-index-save' });
    });
  });
  const run = (writeChains.get(workspace) ?? Promise.resolve())
    .catch(() => { /* the earlier write reported its own error */ })
    .then(write);
  writeChains.set(workspace, run);
  try {
    await run;
  } finally {
    if (writeChains.get(workspace) === run) writeChains.delete(workspace);
  }
}

function pruneFinished(file: IndexFile, now: number): boolean {
  let changed = false;
  for (const [requestId, entry] of Object.entries(file)) {
    const finished = entry.finishedAt ? Date.parse(entry.finishedAt) : NaN;
    if (Number.isFinite(finished) && now - finished > FINISHED_RETENTION_MS) {
      delete file[requestId];
      changed = true;
    }
  }
  return changed;
}

export async function listHumanTaskEntries(): Promise<HumanTaskIndexEntry[]> {
  const file = await readForCaller();
  return Object.values(file).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getHumanTaskEntry(requestId: string): Promise<HumanTaskIndexEntry | null> {
  return (await readForCaller())[requestId] ?? null;
}

/** Add or replace one entry, and forget long-finished ones on the way. */
export async function putHumanTaskEntry(entry: HumanTaskIndexEntry, now: Date = new Date()): Promise<void> {
  await mutate((file) => {
    pruneFinished(file, now.getTime());
    file[entry.requestId] = entry;
    return true;
  });
}

/** Change an entry's status. A missing entry stays missing: the list is not the source of truth. */
export async function updateHumanTaskEntry(
  requestId: string,
  patch: Partial<Pick<HumanTaskIndexEntry, 'status' | 'outcome' | 'decisionId' | 'decidedAt' | 'finishedAt'>>,
  now: Date = new Date(),
): Promise<void> {
  await mutate((file) => {
    const pruned = pruneFinished(file, now.getTime());
    const entry = file[requestId];
    if (!entry) return pruned;
    file[requestId] = { ...entry, ...patch };
    return true;
  });
}

/** Forget entries whose step finished long ago. */
export async function pruneHumanTaskEntries(now: Date = new Date()): Promise<void> {
  await mutate((file) => pruneFinished(file, now.getTime()));
}

/**
 * Keep the list in step with a change the run made. Failing to write the list never
 * fails the run: the step is saved in the conversation and can still be answered in
 * the chat, and the list route drops entries that no longer match a waiting step.
 */
export async function syncHumanTaskEntry(write: () => Promise<void>, what: string): Promise<void> {
  try {
    await write();
  } catch (error) {
    log.warn(`Could not update the Human step list (${what}):`, error);
  }
}
