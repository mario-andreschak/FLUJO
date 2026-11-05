/**
 * Removing recorded examples. The Harness copies the question, answer and tool results
 * of a finished turn to learn from later, so deleting a conversation has to reach here.
 * Examples are only stored when a person turned an automatic Harness profile on.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withWorkspaceRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { deleteCollectionItem, listCollectionItems, loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { getWorkspaceDataDir } from '@/utils/workspace';
import type { HarnessObservation } from '@/shared/types/harnessIntegration';
import { harnessDigest } from './executionScope';

const QUEUES = 'harness-queues';
const observationCollection = (profileId: string) => `harness-observations/${profileId}`;
interface Queue { pending: string[]; job?: { id: string; observations: string[] }; nextRunAt?: number }

export interface HarnessObservationSource {
  profileId: string;
  id: string;
  conversationId?: string;
  sourceRunId: string;
  createdAt: number;
  consumed: boolean;
}

export async function listHarnessObservationSources(): Promise<HarnessObservationSource[]> {
  let profiles: string[];
  try {
    profiles = (await fs.readdir(path.join(getWorkspaceDataDir(), 'db', 'harness-observations'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const sources: HarnessObservationSource[] = [];
  for (const profileId of profiles) {
    for (const item of await listCollectionItems<HarnessObservation>(observationCollection(profileId))) {
      if (!item?.id) continue;
      sources.push({
        profileId,
        id: item.id,
        ...(item.conversationId ? { conversationId: item.conversationId } : {}),
        sourceRunId: item.sourceRunId ?? '',
        createdAt: item.createdAt ?? 0,
        consumed: Boolean(item.consumedBy),
      });
    }
  }
  return sources;
}

/**
 * Returns false only for an example an improvement run is about to read: removing it
 * would fail that run. It is consumed soon after, and the next sweep removes it.
 */
export async function deleteHarnessObservation(profileId: string, id: string): Promise<boolean> {
  return withWorkspaceRuntimeLock(harnessDigest({ lock: 'queue', id: profileId }), async () => {
    const queue = await loadCollectionItem<Queue>(QUEUES, profileId, { pending: [] });
    const observation = await loadCollectionItem<HarnessObservation | null>(observationCollection(profileId), id, null);
    if (queue.job?.observations.includes(id) && !observation?.consumedBy) return false;
    if (queue.pending.includes(id)) {
      await saveCollectionItem(QUEUES, profileId, { ...queue, pending: queue.pending.filter(item => item !== id) });
    }
    await deleteCollectionItem(observationCollection(profileId), id);
    return true;
  });
}
