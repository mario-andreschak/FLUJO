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
export async function getSubflowTaskSettings(): Promise<SubflowTaskSettings> {
  if (settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.value;
  try {
    const stored = await loadItem<Partial<SubflowTaskSettings>>(
      StorageKey.SUBFLOW_TASK_SETTINGS,
      DEFAULT_SUBFLOW_TASK_SETTINGS,
    );
    settingsCache = { value: { ...DEFAULT_SUBFLOW_TASK_SETTINGS, ...stored }, at: Date.now() };
  } catch (error) {
    log.warn('Failed to load subflow task settings; using defaults', error);
    settingsCache = { value: DEFAULT_SUBFLOW_TASK_SETTINGS, at: Date.now() };
  }
  return settingsCache.value;
}
export function _clearSubflowTaskSettingsCache(): void { settingsCache = null; }

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
    return await loadCollectionItem<SubflowTaskRecord | null>(COLLECTION, taskId, null);
  } catch (error) {
    log.warn('Failed to load detached subflow task', { taskId, error });
    return null;
  }
}

export async function patchTask(taskId: string, patch: Partial<Omit<SubflowTaskRecord, 'taskId' | 'uri' | 'version' | 'createdAt'>>): Promise<SubflowTaskRecord | null> {
  try {
    assertSafeCollectionId(taskId);
    return await runInWriteChain(`subflow-task:${taskId}`, async () => {
      const current = await loadCollectionItem<SubflowTaskRecord | null>(COLLECTION, taskId, null);
      if (!current) return null;
      const now = Date.now();
      const next: SubflowTaskRecord = {
        ...current,
        ...patch,
        taskId: current.taskId,
        uri: current.uri,
        version: 1,
        createdAt: current.createdAt,
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
    const filtered = items
      .filter(task => !options.conversationId || task.originConversationId === options.conversationId)
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
  return patchTask(taskId, { status: 'cancelled', cancelRequestedAt: Date.now(), failureReason: 'cancelled' });
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

export async function reconcileOrphanedTasks(): Promise<{ failed: number }> {
  let failed = 0;
  for (const task of await listTasks({ status: 'working', limit: 500 })) {
    if (await patchTask(task.taskId, { status: 'failed', failureReason: 'process-restart', error: 'Detached subflow task was interrupted by a process restart.' })) failed++;
  }
  return { failed };
}

export function toTaskHandle(task: SubflowTaskRecord): SubflowTaskHandle {
  const { version, taskId, uri, status, pollInterval, createdAt, updatedAt, completedAt } = task;
  return { version, taskId, uri, status, pollInterval, createdAt, updatedAt, ...(completedAt ? { completedAt } : {}) };
}
