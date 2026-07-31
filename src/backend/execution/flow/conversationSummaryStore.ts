import path from 'path';
import { promises as fs } from 'fs';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';
import {
  assertSafeCollectionId,
  runInWriteChain,
  writeFileAtomic,
} from '@/utils/storage/backend';
import type { SharedState } from './types';

const log = createLogger('backend/execution/flow/conversationSummaryStore');
const SUMMARY_VERSION = 1;
const SUMMARY_READ_CONCURRENCY = 32;

export type ConversationStatus = NonNullable<SharedState['status']>;

export interface ConversationSummary {
  id: string;
  title: string;
  flowId: string | null;
  status?: ConversationStatus;
  createdAt: number;
  updatedAt: number;
  lastUserMessageAt?: number | null;
  plannedExecutionId?: string | null;
  parentConversationId?: string | null;
  rootConversationId?: string | null;
  recovery?: SharedState['recovery'];
}

interface IndexedConversationSummary extends ConversationSummary {
  version: typeof SUMMARY_VERSION;
  snapshotMtimeMs: number;
  snapshotSize: number;
}

function conversationsDir(): string {
  return path.join(getDataDir(), 'db', 'conversations');
}

function summariesDir(): string {
  return path.join(getDataDir(), 'db', 'conversation-summaries');
}

function snapshotPath(id: string): string {
  return path.join(conversationsDir(), `${id}.json`);
}

function summaryPath(id: string): string {
  return path.join(summariesDir(), `${id}.json`);
}

export function summarizeConversation(state: SharedState, fallbackId: string): ConversationSummary {
  return {
    id: state.conversationId || fallbackId,
    title: state.title || 'Untitled Conversation',
    flowId: state.flowId || null,
    ...(state.status ? { status: state.status } : {}),
    createdAt: state.createdAt || 0,
    updatedAt: state.updatedAt || 0,
    ...(state.lastUserMessageAt !== undefined ? { lastUserMessageAt: state.lastUserMessageAt } : {}),
    ...(state.plannedExecutionId !== undefined ? { plannedExecutionId: state.plannedExecutionId } : {}),
    ...(state.parentConversationId !== undefined ? { parentConversationId: state.parentConversationId } : {}),
    ...(state.rootConversationId !== undefined ? { rootConversationId: state.rootConversationId } : {}),
    ...(state.recovery ? { recovery: state.recovery } : {}),
  };
}

async function writeSummary(
  id: string,
  state: SharedState,
  stats?: { mtimeMs: number; size: number },
): Promise<void> {
  assertSafeCollectionId(id);
  const snapshotStats = stats ?? await fs.stat(snapshotPath(id));
  const indexed: IndexedConversationSummary = {
    version: SUMMARY_VERSION,
    ...summarizeConversation(state, id),
    snapshotMtimeMs: snapshotStats.mtimeMs,
    snapshotSize: snapshotStats.size,
  };
  await runInWriteChain(`conversation-summaries/${id}`, () =>
    writeFileAtomic(summaryPath(id), JSON.stringify(indexed, null, 2)));
}

/** Refresh the derived summary after the authoritative snapshot has been saved. */
export async function persistConversationSummary(id: string, state: SharedState): Promise<void> {
  try {
    await writeSummary(id, state);
  } catch (error) {
    // The summary is a rebuildable index. A failed index write must never turn a
    // successful conversation-state write into a failed run.
    log.warn(`Could not refresh conversation summary ${id}; it will be rebuilt on list.`, error);
  }
}

export async function deleteConversationSummary(id: string): Promise<void> {
  try {
    assertSafeCollectionId(id);
    await runInWriteChain(`conversation-summaries/${id}`, async () => {
      try {
        await fs.unlink(summaryPath(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  } catch (error) {
    // As with writes, stale derived index data must not turn a successful
    // authoritative conversation deletion into a failed API response.
    log.warn(`Could not delete conversation summary ${id}.`, error);
  }
}

async function loadIndexedSummaries(): Promise<Map<string, IndexedConversationSummary>> {
  let files: string[];
  try {
    files = await fs.readdir(summariesDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }

  const result = new Map<string, IndexedConversationSummary>();
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const file = files[cursor++];
      if (!file) return;
      if (!file.endsWith('.json') || file.includes('.tmp.') || file.includes('.corrupted.')) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(summariesDir(), file), 'utf8')) as IndexedConversationSummary;
        const fileId = file.replace(/\.json$/, '');
        assertSafeCollectionId(fileId);
        if (parsed.version === SUMMARY_VERSION && typeof parsed.id === 'string') result.set(fileId, parsed);
      } catch (error) {
        log.warn(`Skipping unreadable conversation summary ${file}; it will be rebuilt if needed.`, error);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(SUMMARY_READ_CONCURRENCY, Math.max(1, files.length)) },
    () => worker(),
  ));
  return result;
}

function withoutIndexFields(indexed: IndexedConversationSummary): ConversationSummary {
  const {
    version: _version,
    snapshotMtimeMs: _snapshotMtimeMs,
    snapshotSize: _snapshotSize,
    ...summary
  } = indexed;
  return summary;
}

/**
 * List lightweight conversation summaries. Legacy or stale index entries read
 * their full snapshot once and are then persisted as tiny sidecars; unchanged
 * snapshots on later calls and process restarts never need their messages parsed.
 */
export async function listConversationSummaries(): Promise<ConversationSummary[]> {
  let files: string[];
  try {
    files = (await fs.readdir(conversationsDir())).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const indexed = await loadIndexedSummaries();
  const results: Array<ConversationSummary | null> = Array(files.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= files.length) return;
      const file = files[index];
      const fallbackId = file.replace(/\.json$/, '');
      try {
        assertSafeCollectionId(fallbackId);
        const filePath = path.join(conversationsDir(), file);
        const stats = await fs.stat(filePath);
        const cached = indexed.get(fallbackId);
        if (
          cached &&
          cached.snapshotMtimeMs === stats.mtimeMs &&
          cached.snapshotSize === stats.size
        ) {
          results[index] = withoutIndexFields(cached);
          continue;
        }

        const state = JSON.parse(await fs.readFile(filePath, 'utf8')) as SharedState;
        results[index] = summarizeConversation(state, fallbackId);
        await writeSummary(fallbackId, state, stats);
      } catch (error) {
        log.warn(`Skipping unreadable conversation snapshot ${file}.`, error);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(SUMMARY_READ_CONCURRENCY, Math.max(1, files.length)) },
    () => worker(),
  ));
  return results.filter((item): item is ConversationSummary => item !== null);
}
