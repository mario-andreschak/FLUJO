import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type {
  PlannedExecution,
  TriggerFirePayload,
} from '@/shared/types/plannedExecution';
import type { SubmitPersonaFlowDispatchInput } from '@/backend/services/enduringAgents/personaDispatcher';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { bindToCurrentWorkspace } from '@/utils/workspace';
import { canonicalJson } from '@/backend/services/enduringAgents/behaviorRevisions';

const KEY = 'scheduler-persona-projections' as StorageKey;
const LOCK_ID = 'scheduler_persona_projections';

function executionGenerationKey(executionId: string, generationId: string): string {
  return `${encodeURIComponent(executionId)}:${encodeURIComponent(generationId)}`;
}

export interface PersonaSchedulerProjection {
  schemaVersion: 1;
  id: string;
  execution: Pick<
    PlannedExecution,
    'id' | 'generationId' | 'name' | 'flowId' | 'personaId'
  >;
  payload: Pick<
    TriggerFirePayload,
    'kind' | 'summary' | 'chainDepth' | 'parentConversationId' | 'deliveryId'
  >;
  submission: SubmitPersonaFlowDispatchInput;
  runId: string;
  conversationId: string;
  firedAt: string;
  dispatchId?: string;
  createdAt: string;
  updatedAt: string;
}

interface PersonaSchedulerProjectionFile {
  version: 1;
  pending: Record<string, PersonaSchedulerProjection>;
  deletedExecutions: Record<string, string>;
  deletedProjections: Record<string, string>;
}

async function loadFile(): Promise<PersonaSchedulerProjectionFile> {
  const stored = await loadItem<PersonaSchedulerProjectionFile>(
    KEY,
    { version: 1, pending: {}, deletedExecutions: {}, deletedProjections: {} },
  );
  return {
    version: 1,
    pending: stored?.version === 1 && stored.pending && typeof stored.pending === 'object'
      ? { ...stored.pending }
      : {},
    deletedExecutions:
      stored?.version === 1
      && stored.deletedExecutions
      && typeof stored.deletedExecutions === 'object'
        ? { ...stored.deletedExecutions }
        : {},
    deletedProjections:
      stored?.version === 1
      && stored.deletedProjections
      && typeof stored.deletedProjections === 'object'
        ? { ...stored.deletedProjections }
        : {},
  };
}

export async function putPersonaSchedulerProjection(
  projection: PersonaSchedulerProjection,
): Promise<PersonaSchedulerProjection> {
  return bindToCurrentWorkspace(() => withPersonaRuntimeLock(LOCK_ID, async (lock) => {
    const file = await loadFile();
    const generationTombstone = projection.execution.generationId
      ? file.deletedExecutions[executionGenerationKey(
          projection.execution.id,
          projection.execution.generationId,
        )]
      : undefined;
    if (
      file.deletedExecutions[projection.execution.id] // legacy id-wide tombstone
      || generationTombstone
      || file.deletedProjections[projection.id]
    ) {
      throw new Error(`Planned execution ${projection.execution.id} was deleted.`);
    }
    const existing = file.pending[projection.id];
    if (existing) {
      // dispatchId is a later lifecycle projection; ignore it for admission
      // identity comparison so an exact source retry remains idempotent.
      const {
        dispatchId: _existingDispatchId,
        firedAt: _existingFiredAt,
        createdAt: _existingCreatedAt,
        updatedAt: _existingUpdatedAt,
        ...existingIntent
      } = existing;
      const {
        dispatchId: _candidateDispatchId,
        firedAt: _candidateFiredAt,
        createdAt: _candidateCreatedAt,
        updatedAt: _candidateUpdatedAt,
        ...candidateIntent
      } = projection;
      if (canonicalJson(existingIntent) !== canonicalJson(candidateIntent)) {
        throw new Error(`Persona scheduler projection ${projection.id} conflicts.`);
      }
      return existing;
    }
    file.pending[projection.id] = projection;
    await lock.assertOwned();
    await saveItem(KEY, file);
    return projection;
  }))();
}

export async function markPersonaSchedulerProjectionAdmitted(
  id: string,
  dispatchId: string,
): Promise<PersonaSchedulerProjection> {
  return bindToCurrentWorkspace(() => withPersonaRuntimeLock(LOCK_ID, async (lock) => {
    const file = await loadFile();
    const existing = file.pending[id];
    if (!existing) throw new Error(`Persona scheduler projection ${id} disappeared.`);
    if (existing.dispatchId && existing.dispatchId !== dispatchId) {
      throw new Error(`Persona scheduler projection ${id} changed dispatch identity.`);
    }
    const updated = {
      ...existing,
      dispatchId,
      updatedAt: new Date().toISOString(),
    };
    file.pending[id] = updated;
    await lock.assertOwned();
    await saveItem(KEY, file);
    return updated;
  }))();
}

export async function listPersonaSchedulerProjections(): Promise<PersonaSchedulerProjection[]> {
  const file = await loadFile();
  return Object.values(file.pending)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function removePersonaSchedulerProjection(id: string): Promise<void> {
  await bindToCurrentWorkspace(() => withPersonaRuntimeLock(LOCK_ID, async (lock) => {
    const file = await loadFile();
    if (!(id in file.pending)) return;
    delete file.pending[id];
    await lock.assertOwned();
    await saveItem(KEY, file);
  }))();
}

export async function removePersonaSchedulerProjectionsForExecution(
  executionId: string,
  generationId?: string,
): Promise<void> {
  await bindToCurrentWorkspace(() => withPersonaRuntimeLock(LOCK_ID, async (lock) => {
    const file = await loadFile();
    let changed = false;
    for (const [id, projection] of Object.entries(file.pending)) {
      if (projection.execution.id === executionId) {
        delete file.pending[id];
        file.deletedProjections[id] = new Date().toISOString();
        changed = true;
      }
    }
    const tombstoneKey = generationId
      ? executionGenerationKey(executionId, generationId)
      : executionId;
    file.deletedExecutions[tombstoneKey] = new Date().toISOString();
    changed = true;
    if (changed) {
      await lock.assertOwned();
      await saveItem(KEY, file);
    }
  }))();
}

/** Clear a prior deletion tombstone only after a same-id execution is created. */
export async function restorePersonaSchedulerExecution(executionId: string): Promise<void> {
  await bindToCurrentWorkspace(() => withPersonaRuntimeLock(LOCK_ID, async (lock) => {
    const file = await loadFile();
    if (!(executionId in file.deletedExecutions)) return;
    delete file.deletedExecutions[executionId];
    await lock.assertOwned();
    await saveItem(KEY, file);
  }))();
}

/**
 * Linearize a terminal projection against execution deletion. If delete wins,
 * no history/outbox write runs; if terminal wins, delete subsequently clears
 * the completed history under the same ordering boundary.
 */
export async function withPersonaSchedulerProjectionGuard<T>(
  executionId: string,
  generationId: string | undefined,
  projectionId: string,
  task: () => Promise<T>,
): Promise<T | null> {
  return bindToCurrentWorkspace(() => withPersonaRuntimeLock(LOCK_ID, async () => {
    const file = await loadFile();
    const generationTombstone = generationId
      ? file.deletedExecutions[executionGenerationKey(executionId, generationId)]
      : undefined;
    if (
      file.deletedExecutions[executionId]
      || generationTombstone
      || file.deletedProjections[projectionId]
    ) return null;
    return task();
  }))();
}
