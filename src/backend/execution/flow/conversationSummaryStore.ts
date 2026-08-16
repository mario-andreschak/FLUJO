import path from 'path';
import { promises as fs } from 'fs';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir } from '@/utils/workspace';
import {
  assertSafeCollectionId,
  runInWriteChain,
  writeFileAtomic,
} from '@/utils/storage/backend';
import type { SharedState } from './types';
import { deriveLastErrorFromLastResponse } from './normalizeError';
import type { NormalizedChatError } from '@/shared/types/execution/errors';
import { isPersonaOwnedConversationState } from './personaConversationOwnership';
import { buildConversationTitle } from '@/utils/shared/conversationTitle';

const log = createLogger('backend/execution/flow/conversationSummaryStore');
// Sidebar titles for automation conversations are now derived from their output
// instead of their trigger prompt. Rebuild older sidecars so existing automation
// rows stop exposing the appended run-info block too.
const SUMMARY_VERSION = 9;
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
  /** User-facing resolved key for a persisted keyed child session. */
  sessionKey?: string;
  /** Internal stable correlation identity; returned for clients that need correlation, never displayed. */
  sessionIdentity?: string;
  recovery?: SharedState['recovery'];
  /** Durable invocation origin used by the chat sidebar's origin filter/chip. */
  source?: SharedState['source'] | null;
  /** Internal list-filter marker; never identifies the Persona or grants authority. */
  personaOwned?: true;
  /** Non-identifying marker for a read-only anonymized Persona archive. */
  personaArchived?: true;
  /** Trusted-local Persona attribution projection (drafts expose only personaId). */
  personaId?: string;
  /** User-selected Main role (`primary`) or named Persona Behavior. */
  personaBehaviorSlotKey?: string;
  activityId?: string;
  behaviorRevisionId?: string;
  /**
   * Issue #383: a COMPACT error projection only — message/code/class, never
   * the redacted provider `details` blob or a stack trace — so bulk sidebar
   * listing stays small. The full `NormalizedChatError` (with `details`) is
   * only ever served by the single-conversation GET route.
   */
  lastError?: { message: string; code?: string; errorClass?: NormalizedChatError['errorClass'] };
}

interface IndexedConversationSummary extends ConversationSummary {
  version: typeof SUMMARY_VERSION;
  snapshotMtimeMs: number;
  snapshotSize: number;
}

function conversationsDir(): string {
  return path.join(getWorkspaceDataDir(), 'db', 'conversations');
}

function summariesDir(): string {
  return path.join(getWorkspaceDataDir(), 'db', 'conversation-summaries');
}

function snapshotPath(id: string): string {
  return path.join(conversationsDir(), `${id}.json`);
}

function summaryPath(id: string): string {
  return path.join(summariesDir(), `${id}.json`);
}

function latestAssistantText(state: SharedState): string | undefined {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
      return message.content;
    }
  }
  return undefined;
}

/**
 * Resolve the title exposed by the conversation-list API.
 *
 * Automation prompts include a fenced trigger-data block for the model. That
 * content is useful in the transcript, but makes every saved automation look
 * identical in the sidebar. Successful automation runs therefore use their
 * returned output as the preview title. While output is unavailable (running,
 * paused, or failed), use the planned-execution name and never the trigger
 * prompt. Descendant subflow conversations keep their own authored titles.
 */
export function conversationSidebarTitle(
  state: SharedState,
  fallbackTitle = 'Untitled Conversation',
): string {
  const isAutomation = state.source === 'schedule'
    || (!state.source && Boolean(state.plannedExecutionId) && !state.parentConversationId);
  if (!isAutomation) return state.title || fallbackTitle;

  if (state.status === 'completed' || state.status === 'capped') {
    const outputText = typeof state.lastResponse === 'string' && state.lastResponse.trim()
      ? state.lastResponse
      : latestAssistantText(state);
    if (outputText) return buildConversationTitle(outputText);
  }

  const executionName = state.statisticsPlannedExecutionName?.trim();
  return executionName ? buildConversationTitle(executionName) : 'Automation run';
}

export function summarizeConversation(state: SharedState, fallbackId: string): ConversationSummary {
  return {
    id: state.conversationId || fallbackId,
    title: conversationSidebarTitle(state),
    flowId: state.flowId || null,
    ...(state.status ? { status: state.status } : {}),
    createdAt: state.createdAt || 0,
    updatedAt: state.updatedAt || 0,
    ...(state.lastUserMessageAt !== undefined ? { lastUserMessageAt: state.lastUserMessageAt } : {}),
    ...(state.plannedExecutionId !== undefined ? { plannedExecutionId: state.plannedExecutionId } : {}),
    ...(state.parentConversationId !== undefined ? { parentConversationId: state.parentConversationId } : {}),
    ...(state.rootConversationId !== undefined ? { rootConversationId: state.rootConversationId } : {}),
    ...(state.subflowLane?.sessionKey ? { sessionKey: state.subflowLane.sessionKey } : {}),
    ...(state.subflowLane?.sessionIdentity ? { sessionIdentity: state.subflowLane.sessionIdentity } : {}),
    ...(state.recovery ? { recovery: state.recovery } : {}),
    ...(state.source !== undefined ? { source: state.source } : {}),
    ...(isPersonaOwnedConversationState(state)
      ? { personaOwned: true as const }
      : {}),
    ...(state.personaArchived ? { personaArchived: true as const } : {}),
    ...((state.personaAttribution?.personaId ?? state.personaTargetId)
      ? { personaId: state.personaAttribution?.personaId ?? state.personaTargetId }
      : {}),
    ...((state.personaAttribution?.personaId ?? state.personaTargetId) && state.personaBehaviorSlotKey
      ? { personaBehaviorSlotKey: state.personaBehaviorSlotKey }
      : {}),
    ...(state.personaAttribution?.activityId
      ? { activityId: state.personaAttribution.activityId }
      : {}),
    ...(state.personaAttribution?.behaviorRevisionId
      ? { behaviorRevisionId: state.personaAttribution.behaviorRevisionId }
      : {}),
    ...(state.status === 'error' ? (() => {
      const err = state.lastError ?? deriveLastErrorFromLastResponse(state.lastResponse);
      return err
        ? { lastError: { message: err.message, ...(err.code ? { code: err.code } : {}), ...(err.errorClass ? { errorClass: err.errorClass } : {}) } }
        : {};
    })() : {}),
  };
}

async function writeSummary(
  id: string,
  state: SharedState,
  stats?: { mtimeMs: number; size: number },
): Promise<void> {
  assertSafeCollectionId(id);
  if (state.personaAttribution && !state.executionAuthority) {
    throw new Error(
      'Persona-attributed conversation summaries require current execution authority.',
    );
  }
  const write = async () => {
    const snapshotStats = stats ?? await fs.stat(snapshotPath(id));
    const indexed: IndexedConversationSummary = {
      version: SUMMARY_VERSION,
      ...summarizeConversation(state, id),
      snapshotMtimeMs: snapshotStats.mtimeMs,
      snapshotSize: snapshotStats.size,
    };
    await runInWriteChain(`conversation-summaries/${id}`, () =>
      writeFileAtomic(summaryPath(id), JSON.stringify(indexed, null, 2)));
  };
  if (state.executionAuthority?.commitWhileCurrent) {
    await state.executionAuthority.commitWhileCurrent(write);
  } else {
    await state.executionAuthority?.assertCurrent();
    await write();
  }
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

/**
 * Privacy migrations cannot tolerate a stale identity-bearing sidecar. Unlike
 * the normal rebuildable-index path, surface any failure to the deletion
 * workflow so its durable tombstone remains retryable rather than completed.
 */
export async function persistConversationSummaryStrict(
  id: string,
  state: SharedState,
): Promise<void> {
  await writeSummary(id, state);
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
