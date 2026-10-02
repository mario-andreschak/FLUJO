import { randomUUID } from 'crypto';
import { createLogger } from '@/utils/logger';
import {
  assertSafeCollectionId,
  deleteCollectionItem,
  listCollectionItems,
  loadCollectionItem,
  loadItem,
  runInWriteChain,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import {
  DEFAULT_SUBFLOW_TASK_SETTINGS,
  SUBFLOW_TASK_SCHEME,
  type SubflowTaskHandle,
  type SubflowTaskRecord,
  type SubflowTaskSettings,
  type SubflowTaskStatus,
} from '@/shared/types/subflowTasks';
import { DEFAULT_WORKSPACE, getCurrentWorkspace } from '@/utils/workspace';
import type { SharedState } from '@/backend/execution/flow/types';
import { getDetachedTaskLaunchOwner, isPriorLocalTaskOwner } from './ownership';

const log = createLogger('backend/services/subflowTasks');
const COLLECTION = 'subflow-tasks';
const TERMINAL = new Set<SubflowTaskStatus>(['completed', 'failed', 'cancelled']);

export function buildSubflowTaskUri(taskId: string): string {
  assertSafeCollectionId(taskId);
  return `${SUBFLOW_TASK_SCHEME}${taskId}`;
}

export function parseSubflowTaskUri(uri: string): string | null {
  if (typeof uri !== 'string' || !uri.startsWith(SUBFLOW_TASK_SCHEME)) return null;
  const taskId = uri.slice(SUBFLOW_TASK_SCHEME.length);
  try {
    assertSafeCollectionId(taskId);
    return taskId;
  } catch {
    return null;
  }
}

let settingsCache: { value: SubflowTaskSettings; at: number } | null = null;
const settingsCacheByWorkspace = new Map<string, { value: SubflowTaskSettings; at: number }>();

function getSettingsCache(): { value: SubflowTaskSettings; at: number } | null {
  const workspace = getCurrentWorkspace();
  return workspace === DEFAULT_WORKSPACE
    ? settingsCache
    : settingsCacheByWorkspace.get(workspace) ?? null;
}

function setSettingsCache(value: { value: SubflowTaskSettings; at: number } | null): void {
  const workspace = getCurrentWorkspace();
  if (workspace === DEFAULT_WORKSPACE) settingsCache = value;
  else if (value) settingsCacheByWorkspace.set(workspace, value);
  else settingsCacheByWorkspace.delete(workspace);
}

export async function getSubflowTaskSettings(): Promise<SubflowTaskSettings> {
  const cached = getSettingsCache();
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  try {
    const stored = await loadItem<Partial<SubflowTaskSettings>>(
      StorageKey.SUBFLOW_TASK_SETTINGS,
      DEFAULT_SUBFLOW_TASK_SETTINGS,
    );
    setSettingsCache({ value: { ...DEFAULT_SUBFLOW_TASK_SETTINGS, ...stored }, at: Date.now() });
  } catch (error) {
    log.warn('Failed to load subflow task settings; using defaults', error);
    setSettingsCache({ value: DEFAULT_SUBFLOW_TASK_SETTINGS, at: Date.now() });
  }
  return getSettingsCache()!.value;
}
export function _clearSubflowTaskSettingsCache(): void { setSettingsCache(null); }

export async function createTask(input: Omit<SubflowTaskRecord, keyof SubflowTaskHandle | 'taskId' | 'uri' | 'createdAt' | 'updatedAt'> & Partial<Pick<SubflowTaskHandle, 'pollInterval' | 'status'>>): Promise<SubflowTaskRecord | null> {
  try {
    const settings = await getSubflowTaskSettings();
    const now = Date.now();
    const taskId = randomUUID();
    const record: SubflowTaskRecord = {
      ...input,
      version: 1,
      taskId,
      uri: buildSubflowTaskUri(taskId),
      status: input.status ?? 'working',
      pollInterval: input.pollInterval ?? settings.defaultPollIntervalMs,
      createdAt: now,
      updatedAt: now,
      launchOwner: await getDetachedTaskLaunchOwner(),
    };
    await saveCollectionItem(COLLECTION, taskId, record);
    return record;
  } catch (error) {
    log.warn('Failed to create detached subflow task', error);
    return null;
  }
}

export async function getTask(taskId: string): Promise<SubflowTaskRecord | null> {
  try {
    assertSafeCollectionId(taskId);
    const task = await loadCollectionItem<SubflowTaskRecord | null>(COLLECTION, taskId, null);
    return task ? await reconcileTaskInterruption(task) : null;
  } catch (error) {
    log.warn('Failed to load detached subflow task', { taskId, error });
    return null;
  }
}

export async function patchTask(taskId: string, patch: Partial<Omit<SubflowTaskRecord, 'taskId' | 'uri' | 'version' | 'createdAt' | 'launchOwner'>>, options: { ifStatus?: SubflowTaskStatus } = {}): Promise<SubflowTaskRecord | null> {
  try {
    assertSafeCollectionId(taskId);
    return await runInWriteChain(`subflow-task:${taskId}`, async () => {
      const current = await loadCollectionItem<SubflowTaskRecord | null>(COLLECTION, taskId, null);
      if (!current) return null;
      if (options.ifStatus && current.status !== options.ifStatus) return current;
      const now = Date.now();
      const next: SubflowTaskRecord = {
        ...current,
        ...patch,
        taskId: current.taskId,
        uri: current.uri,
        version: 1,
        createdAt: current.createdAt,
        launchOwner: current.launchOwner,
        updatedAt: now,
      };
      if (TERMINAL.has(next.status) && !next.completedAt) next.completedAt = now;
      await saveCollectionItem(COLLECTION, taskId, next);
      return next;
    });
  } catch (error) {
    log.warn('Failed to update detached subflow task', { taskId, error });
    return null;
  }
}

export async function listTasks(options: { conversationId?: string; status?: SubflowTaskStatus; limit?: number; offset?: number } = {}): Promise<SubflowTaskRecord[]> {
  try {
    const items = await listCollectionItems<SubflowTaskRecord>(COLLECTION);
    const selected = items.filter(task => !options.conversationId || task.originConversationId === options.conversationId);
    const reconciled = await Promise.all(selected.map(task => reconcileTaskInterruption(task)));
    const filtered = reconciled
      .filter(task => !options.status || task.status === options.status)
      .sort((a, b) => b.createdAt - a.createdAt);
    return filtered.slice(options.offset ?? 0, (options.offset ?? 0) + Math.max(1, Math.min(options.limit ?? 100, 500)));
  } catch (error) {
    log.warn('Failed to list detached subflow tasks', error);
    return [];
  }
}

export async function requestCancel(taskId: string): Promise<SubflowTaskRecord | null> {
  const current = await getTask(taskId);
  if (!current || TERMINAL.has(current.status)) return current;
  return patchTask(taskId, { status: 'cancelled', cancelRequestedAt: Date.now(), failureReason: 'cancelled' }, { ifStatus: current.status });
}

export async function sweepOldSubflowTasks(now = Date.now()): Promise<{ removed: number }> {
  const settings = await getSubflowTaskSettings();
  if (settings.retentionAgeDays <= 0) return { removed: 0 };
  const cutoff = now - settings.retentionAgeDays * 24 * 60 * 60 * 1_000;
  let removed = 0;
  for (const task of await listCollectionItems<SubflowTaskRecord>(COLLECTION)) {
    if ((task.expiresAt ?? task.updatedAt) > cutoff) continue;
    try { await deleteCollectionItem(COLLECTION, task.taskId); removed++; } catch (error) { log.warn('Failed to sweep detached subflow task', { taskId: task.taskId, error }); }
  }
  return { removed };
}

/** Reconcile only proven local launches; imported and legacy tasks stay untouched. */
async function reconcileTaskInterruption(task: SubflowTaskRecord): Promise<SubflowTaskRecord> {
  if (task.status !== 'working' || !task.launchOwner) return task;
  try {
    return await runInWriteChain(`subflow-task:${task.taskId}`, async () => {
      const current = await loadCollectionItem<SubflowTaskRecord | null>(COLLECTION, task.taskId, null);
      if (!current || current.status !== 'working' || !await isPriorLocalTaskOwner(current.launchOwner)) return current ?? task;
      const { FlowExecutor } = await import('@/backend/execution/flow/FlowExecutor');
      const live = FlowExecutor.conversationStates.get(current.childConversationId);
      if (live && ['running', 'paused_debug', 'awaiting_tool_approval'].includes(live.status ?? '')) return current;
      assertSafeCollectionId(current.childConversationId);
      const key = `conversations/${current.childConversationId}` as StorageKey;
      let child = await loadItem<SharedState | undefined>(key, undefined);
      if (!child || child.conversationId !== current.childConversationId || child.flowId !== current.flowId
        || child.parentRunId !== current.originConversationId
        || (current.originLogicalRunId && child.parentLogicalRunId !== current.originLogicalRunId)
        || child.recovery?.ownerId !== current.launchOwner!.recoveryOwnerId
        || child.recovery.startedAt < current.createdAt) return current;

      // Proven dead, locally owned ordinary children can use normal interruption
      // recovery. Persona/extension snapshots require their own runtime authority.
      if (child.status === 'running' && !child.personaAttribution && !child.executionExtensionOwned && !child.ephemeral) {
        const { reconcileInterruptedRecovery } = await import('@/backend/execution/flow/recoveryCheckpoint');
        await reconcileInterruptedRecovery(key, child);
        // Persistence can legitimately refuse a deleted/ephemeral snapshot.
        // An in-memory transition alone is never evidence for task recovery.
        child = await loadItem<SharedState | undefined>(key, undefined);
      }
      const recovery = child?.recovery;
      if (child?.conversationId !== current.childConversationId || child.flowId !== current.flowId
        || child.parentRunId !== current.originConversationId
        || (current.originLogicalRunId && child.parentLogicalRunId !== current.originLogicalRunId)
        || recovery?.ownerId !== current.launchOwner!.recoveryOwnerId
        || child.status !== 'error' || recovery.classification !== 'interrupted'
        || !recovery.terminalAt || recovery.manualActionRequired !== true || recovery.failure?.retryable !== false) return current;
      const now = Date.now();
      const next: SubflowTaskRecord = {
        ...current,
        status: 'failed',
        failureReason: 'process-restart',
        error: 'Detached subflow task was interrupted by a process restart. Manual recovery is required; interrupted work was not replayed.',
        completedAt: current.completedAt ?? now,
        updatedAt: now,
        interruption: {
          childConversationId: current.childConversationId,
          recoveryOwnerId: recovery.ownerId!,
          terminalAt: recovery.terminalAt,
          reconciledAt: now,
          classification: 'interrupted',
          manualActionRequired: true,
        },
      };
      await saveCollectionItem(COLLECTION, current.taskId, next);
      return next;
    });
  } catch (error) {
    log.warn('Could not reconcile detached task interruption', { taskId: task.taskId, error });
    return task;
  }
}

export async function reconcileOrphanedTasks(): Promise<{ failed: number }> {
  let failed = 0;
  // Do not limit recovery to the first page or reuse listTasks, which already
  // reconciles reads and would hide the number of startup transitions.
  for (const task of await listCollectionItems<SubflowTaskRecord>(COLLECTION)) {
    if (task.status === 'working' && (await reconcileTaskInterruption(task)).status === 'failed') failed++;
  }
  return { failed };
}

export function toTaskHandle(task: SubflowTaskRecord): SubflowTaskHandle {
  const { version, taskId, uri, status, pollInterval, createdAt, updatedAt, completedAt } = task;
  return { version, taskId, uri, status, pollInterval, createdAt, updatedAt, ...(completedAt ? { completedAt } : {}) };
}
