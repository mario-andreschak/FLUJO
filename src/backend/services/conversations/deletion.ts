/**
 * The one way to remove a stored conversation and everything attached to it.
 *
 * The conversation routes and the retention sweep all come through here, so a store
 * added later only has to be added once. Steps, in order:
 *
 *   tombstone (for a running run, before the lock) -> lock -> caller's guard ->
 *   deletion marker -> tombstone -> state file and its backups -> summary ->
 *   flow cache -> conversation log -> model-turn archive -> run resources ->
 *   subflow tasks -> native tool records -> scheduler run text -> harness evidence ->
 *   check nothing is left -> marker removed
 *
 * The marker is a small file holding no text. If the process stops halfway, or a file
 * cannot be removed yet (Windows may refuse while another program has it open),
 * the marker stays and `finishInterruptedConversationDeletions` completes the work,
 * so a partial deletion cannot quietly leave text behind.
 *
 * Not covered, because they are not owned by one conversation: see
 * docs/operations/conversation-retention.md.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock, isConversationExecutionLocked } from '@/backend/execution/flow/conversationExecutionLock';
import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { deleteConversationLog } from '@/backend/execution/flow/conversationLog';
import { deleteConversationSummary } from '@/backend/execution/flow/conversationSummaryStore';
import { deleteModelTurnArchive } from '@/backend/execution/flow/modelTurnArchive';
import { markConversationDeleted, unmarkConversationDeleted } from '@/backend/execution/flow/cancellation';
import { forget as forgetConversationCacheEntry } from '@/backend/execution/flow/conversationStateCache';
import type { SharedState } from '@/backend/execution/flow/types';
import { deleteRunResources } from '@/backend/services/runResources';
import { deleteNativeInvocationRecords, listNativeInvocationOwners } from '@/backend/execution/flow/handlers/nativeToolJournal';
import { scrubRunRecordText } from '@/backend/services/scheduler/runHistory';
import { deleteHarnessObservation, listHarnessObservationSources } from '@/backend/services/harness/observationStore';
import {
  assertSafeCollectionId,
  deleteCollectionItem,
  listCollectionItems,
  loadItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import type { StorageKey } from '@/shared/types/storage';
import { quickChatFlowId } from '@/utils/shared/quickChat';

const log = createLogger('backend/services/conversations/deletion');

const MARKERS = 'conversation-deletions';
const SUBFLOW_TASKS = 'subflow-tasks';

interface DeletionMarker {
  version: 1;
  conversationId: string;
  startedAt: number;
  plannedExecutionId?: string;
  logicalRunId?: string;
}

/**
 * What other stores hold for each conversation. Finding this needs a scan of those
 * stores, so a caller removing many conversations builds it once and passes it along.
 */
export interface ConversationDeletionIndex {
  /** Backups and half-written temp files next to a state file. */
  stateSiblings: Map<string, string[]>;
  subflowTaskIds: Map<string, string[]>;
  /** `resolved` is false while a native call may still have an unknown effect. */
  nativeInvocations: Map<string, Array<{ invocationId: string; resolved: boolean }>>;
  harnessObservations: Array<{ profileId: string; id: string; conversationId?: string; sourceRunId: string; createdAt: number; consumed: boolean }>;
}

function addTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function conversationStateDir(): string {
  return path.join(getWorkspaceDataDir(), 'db', 'conversations');
}

/** `<id>.json.corrupted.<time>.bak` and `<id>.json.tmp.<uuid>`, which hold a full copy of the text. */
export function stateSiblingOwner(fileName: string): string | undefined {
  const match = /^([A-Za-z0-9_-]+)\.json\.(?:corrupted|tmp)\./.exec(fileName);
  return match?.[1];
}

export async function buildConversationDeletionIndex(): Promise<ConversationDeletionIndex> {
  const stateSiblings = new Map<string, string[]>();
  try {
    for (const name of await fs.readdir(conversationStateDir())) {
      const owner = stateSiblingOwner(name);
      if (owner) addTo(stateSiblings, owner, name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const subflowTaskIds = new Map<string, string[]>();
  for (const task of await listCollectionItems<SubflowTaskRecord>(SUBFLOW_TASKS)) {
    if (!task?.taskId) continue;
    if (task.originConversationId) addTo(subflowTaskIds, task.originConversationId, task.taskId);
    if (task.childConversationId && task.childConversationId !== task.originConversationId) {
      addTo(subflowTaskIds, task.childConversationId, task.taskId);
    }
  }

  const nativeInvocations = new Map<string, Array<{ invocationId: string; resolved: boolean }>>();
  for (const owner of await listNativeInvocationOwners()) {
    addTo(nativeInvocations, owner.conversationId, { invocationId: owner.invocationId, resolved: owner.resolved });
  }

  return { stateSiblings, subflowTaskIds, nativeInvocations, harnessObservations: await listHarnessObservationSources() };
}

export interface DeleteConversationOptions<R> {
  /**
   * Stop a running run first, as a person pressing Delete expects: the run holds the
   * lock until it notices. The retention sweep never asks for this.
   */
  cancelRunning?: boolean;
  /**
   * Runs under the lock with the authoritative state, before anything is removed.
   * Returning anything but `undefined` refuses the deletion and is handed back.
   */
  guard?: (state: SharedState | undefined) => Promise<R | undefined> | R | undefined;
  /** How to read the state. Bulk delete reads under the shared read limit. */
  loadState?: (conversationId: string) => Promise<SharedState | undefined>;
  /** Build once when removing many. */
  index?: ConversationDeletionIndex;
  /** Set when finishing an interrupted deletion: the state may be gone or unreadable. */
  resumeMarker?: DeletionMarker;
}

export type DeleteConversationResult<R> =
  | { deleted: true; /** False when a leftover remains; its marker retries it later. */ complete: boolean }
  | { deleted: false; refusal: R };

/** A marker left behind only costs one harmless retry. */
async function dropMarker(conversationId: string): Promise<void> {
  try { await deleteCollectionItem(MARKERS, conversationId); }
  catch (error) { log.warn('Could not remove a deletion marker', { conversationId, error }); }
}

const pathExists = (target: string) => fs.lstat(target).then(() => true, () => false);

/** Everything named after this conversation that must be gone afterwards. */
function ownedPaths(conversationId: string): string[] {
  const db = path.join(getWorkspaceDataDir(), 'db');
  return [
    path.join(db, 'conversations', `${conversationId}.json`),
    path.join(db, 'conversation-summaries', `${conversationId}.json`),
    path.join(db, 'conversation-logs', `${conversationId}.jsonl`),
    path.join(db, 'model-turns', conversationId),
    path.join(db, 'run-resources', conversationId),
  ];
}

/**
 * Remove one conversation and everything attached to it. Throws when the state file
 * could not be removed, leaving the conversation usable. Once the state file is gone
 * the deletion always goes on, and any later failure is finished through the marker.
 */
export async function deleteConversationCompletely<R = never>(
  conversationId: string,
  options: DeleteConversationOptions<R> = {},
): Promise<DeleteConversationResult<R>> {
  assertSafeCollectionId(conversationId);

  // A running legacy execution already holds the conversation lease. Preserve
  // tombstone-first cancellation so a delete does not wait for an unbounded run
  // before it can request shutdown; ownership is still re-read authoritatively
  // after the lease is acquired and no destructive write happens before then.
  let tombstonedBeforeLock = false;
  if (options.cancelRunning) {
    const preLockLiveState = FlowExecutor.conversationStates.get(conversationId);
    if (preLockLiveState?.status === 'running' && !isPersonaOwnedConversationState(preLockLiveState)) {
      markConversationDeleted(conversationId);
      tombstonedBeforeLock = true;
      preLockLiveState.isCancelled = true;
    }
  }

  return withConversationExecutionLock(conversationId, async () => {
    let stateRemoved = false;
    let markerWritten = false;
    try {
      const existingState = options.resumeMarker
        ? undefined
        : FlowExecutor.conversationStates.get(conversationId)
          ?? await (options.loadState
            ? options.loadState(conversationId)
            : loadItem<SharedState | undefined>(`conversations/${conversationId}` as StorageKey, undefined));
      const refusal = await options.guard?.(existingState);
      if (refusal !== undefined) {
        if (tombstonedBeforeLock) unmarkConversationDeleted(conversationId);
        return { deleted: false, refusal };
      }

      const marker: DeletionMarker = options.resumeMarker ?? {
        version: 1,
        conversationId,
        startedAt: Date.now(),
        ...(existingState?.plannedExecutionId ? { plannedExecutionId: existingState.plannedExecutionId } : {}),
        ...(existingState?.logicalRunId ? { logicalRunId: existingState.logicalRunId } : {}),
      };
      try {
        if (!options.resumeMarker) await saveCollectionItem(MARKERS, conversationId, marker);
        markerWritten = true;
      } catch (error) {
        // A full disk is when deleting matters most. Go on, only without the retry.
        log.warn('Could not write a deletion marker; continuing', { conversationId, error });
      }

      // Tombstone FIRST: from here on, the persistence chokepoint and the
      // conversation-log tap refuse this id, so an in-flight run can no longer
      // re-write ("resurrect") the files we are about to remove. Rolled back
      // below if the state file cannot be deleted.
      markConversationDeleted(conversationId);

      // Stop any in-flight run and clean up the in-memory state. The running
      // loop holds a closure reference to this same state object, so setting the
      // flag reaches it. While the run is 'running' the entry must STAY in the
      // map: descendant subflows walk it for ancestor cancellation, and runFlow's
      // final cleanup drops it (tombstoned ids are never re-registered).
      const inMemoryState = FlowExecutor.conversationStates.get(conversationId);
      if (inMemoryState) {
        inMemoryState.isCancelled = true;
        if (inMemoryState.status !== 'running') {
          FlowExecutor.conversationStates.delete(conversationId);
          forgetConversationCacheEntry(conversationId);
        }
      }

      // Delete the state file through the storage layer: same path derivation as
      // every writer, and the per-key write chain serializes the unlink behind any
      // in-flight persist of the same conversation.
      await deleteCollectionItem('conversations', conversationId);
      stateRemoved = true;

      const index = options.index ?? await buildConversationDeletionIndex();
      const failures: string[] = [];
      const step = async (name: string, task: () => Promise<unknown>) => {
        try { await task(); }
        catch (error) {
          if (error instanceof ConversationLogReadPressureError) throw error;
          failures.push(name);
          log.warn(`Could not finish removing a conversation's ${name}; it will be retried`, { conversationId, error });
        }
      };

      for (const name of index.stateSiblings.get(conversationId) ?? []) {
        await step('state backup', () => fs.rm(path.join(conversationStateDir(), name), { force: true }));
      }
      await step('summary', () => deleteConversationSummary(conversationId));
      // A Quick-Chat (issue #61) carried its flow as an in-memory snapshot compiled
      // under the namespaced id quickchat-<conversationId>; evict that cache entry
      // so snapshots don't accumulate. Targeted by id, so it can never evict a
      // real (shared) flow's compiled cache.
      FlowExecutor.clearFlowCache(quickChatFlowId(conversationId));
      await step('log', () => deleteConversationLog(conversationId));
      // Exact historical SDK-request sidecars and their archived media.
      await step('model-turn archive', () => deleteModelTurnArchive(conversationId));
      // Run-scoped resources, including images and spilled tool results.
      await step('run resources', () => deleteRunResources(conversationId));
      for (const taskId of index.subflowTaskIds.get(conversationId) ?? []) {
        await step('subflow task', () => deleteCollectionItem(SUBFLOW_TASKS, taskId));
      }
      await step('native tool records', () => deleteNativeInvocationRecords(
        conversationId,
        (index.nativeInvocations.get(conversationId) ?? []).filter(item => item.resolved).map(item => item.invocationId),
      ));
      if (marker.plannedExecutionId) {
        await step('scheduler run text', () => scrubRunRecordText(
          marker.plannedExecutionId!,
          record => record.conversationId === conversationId,
        ));
      }
      for (const item of index.harnessObservations) {
        if (item.conversationId === conversationId
          || item.sourceRunId.startsWith(`${conversationId}:`)
          || (marker.logicalRunId && item.sourceRunId === marker.logicalRunId)) {
          await step('harness evidence', () => deleteHarnessObservation(item.profileId, item.id));
        }
      }

      const leftover = (await Promise.all(ownedPaths(conversationId).map(pathExists))).some(Boolean);
      const complete = failures.length === 0 && !leftover;
      if (complete && markerWritten) await dropMarker(conversationId);
      return { deleted: true, complete };
    } catch (error) {
      if (!stateRemoved) {
        // The conversation still exists (delete failed): clear the tombstone so it
        // isn't left permanently unpersistable/unloggable, and drop the marker so a
        // later retry cannot remove a conversation the caller was told still exists.
        unmarkConversationDeleted(conversationId);
        if (markerWritten && !options.resumeMarker) await dropMarker(conversationId);
      }
      throw error;
    }
  });
}

/**
 * Finish deletions that stopped partway. Cheap when there are none: one directory read.
 * A conversation created again under the same id after its deletion started is left
 * alone, and only its marker is dropped.
 */
export async function finishInterruptedConversationDeletions(): Promise<{ finished: number; pending: number }> {
  const markers = await listCollectionItems<DeletionMarker>(MARKERS);
  let finished = 0;
  let pending = 0;
  if (markers.length === 0) return { finished, pending };
  const index = await buildConversationDeletionIndex();
  for (const marker of markers) {
    const id = marker?.conversationId;
    if (typeof id !== 'string' || !id) continue;
    try {
      assertSafeCollectionId(id);
      if (isConversationExecutionLocked(id)) { pending++; continue; }
      const current = await readStateTolerantly(id);
      if (current && typeof current.updatedAt === 'number' && current.updatedAt > marker.startedAt) {
        await deleteCollectionItem(MARKERS, id);
        continue;
      }
      const result = await deleteConversationCompletely(id, { resumeMarker: marker, index });
      if (result.deleted && result.complete) finished++;
      else pending++;
    } catch (error) {
      pending++;
      log.warn('Could not finish an interrupted conversation deletion', { conversationId: id, error });
    }
  }
  return { finished, pending };
}

/** Read without the storage layer's corruption backup, which would copy the text again. */
async function readStateTolerantly(conversationId: string): Promise<Pick<SharedState, 'updatedAt'> | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(conversationStateDir(), `${conversationId}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}
