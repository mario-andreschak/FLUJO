import { bindToCurrentWorkspace } from '@/utils/workspace';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { canonicalJson } from '@/backend/services/enduringAgents/behaviorRevisions';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type {
  PlannedExecution,
  TriggerFirePayload,
} from '@/shared/types/plannedExecution';

const KEY = 'scheduler-file-watch-intents' as StorageKey;
const LOCK_ID = 'scheduler_file_watch_intents';

export interface DurableFileWatchIntent {
  schemaVersion: 1;
  id: string;
  execution: PlannedExecution & { personaId: string };
  payload: TriggerFirePayload & { kind: 'file'; deliveryId: string };
  createdAt: string;
}

interface DurableFileWatchIntentFile {
  version: 1;
  pending: Record<string, DurableFileWatchIntent>;
}

async function loadFile(): Promise<DurableFileWatchIntentFile> {
  const stored = await loadItem<DurableFileWatchIntentFile>(KEY, {
    version: 1,
    pending: {},
  });
  return {
    version: 1,
    pending: stored?.version === 1 && stored.pending && typeof stored.pending === 'object'
      ? { ...stored.pending }
      : {},
  };
}

/** Persist the process-observed batch before the watcher releases its memory. */
export async function putDurableFileWatchIntent(
  intent: DurableFileWatchIntent,
): Promise<DurableFileWatchIntent> {
  return bindToCurrentWorkspace(() => withPersonaRuntimeLock(LOCK_ID, async (lock) => {
    const file = await loadFile();
    const existing = file.pending[intent.id];
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(intent)) {
        throw new Error(`File-watch intent ${intent.id} conflicts.`);
      }
      return existing;
    }
    file.pending[intent.id] = intent;
    await lock.assertOwned();
    await saveItem(KEY, file);
    return intent;
  }))();
}

export async function listDurableFileWatchIntents(): Promise<DurableFileWatchIntent[]> {
  const file = await loadFile();
  return Object.values(file.pending)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function removeDurableFileWatchIntent(id: string): Promise<void> {
  await bindToCurrentWorkspace(() => withPersonaRuntimeLock(LOCK_ID, async (lock) => {
    const file = await loadFile();
    if (!(id in file.pending)) return;
    delete file.pending[id];
    await lock.assertOwned();
    await saveItem(KEY, file);
  }))();
}

export async function removeDurableFileWatchIntentsForExecution(
  executionId: string,
  generationId: string,
): Promise<void> {
  await bindToCurrentWorkspace(() => withPersonaRuntimeLock(LOCK_ID, async (lock) => {
    const file = await loadFile();
    let changed = false;
    for (const [id, intent] of Object.entries(file.pending)) {
      if (
        intent.execution.id === executionId
        && intent.execution.generationId === generationId
      ) {
        delete file.pending[id];
        changed = true;
      }
    }
    if (!changed) return;
    await lock.assertOwned();
    await saveItem(KEY, file);
  }))();
}
