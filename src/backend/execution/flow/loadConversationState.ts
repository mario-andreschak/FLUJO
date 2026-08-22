import { FlowExecutor } from './FlowExecutor';
import { loadItem as loadItemBackend, assertSafeCollectionId } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { SharedState } from './types';
import { recoverMessagesFromLog, repairDanglingToolCalls, appendRawForState } from './conversationLog';
import { persistConversationState } from './persistConversationState';
import { createLogger } from '@/utils/logger';
import {
  markDanglingToolEffectsUnknown,
  reconcileInterruptedRecovery,
} from './recoveryCheckpoint';
import { coalesceLoad, noteRead, noteWrite } from './conversationStateCache';
import { validateCompactionState } from './compaction/state';

const log = createLogger('backend/execution/flow/loadConversationState');

/**
 * Read canonical conversation state without adopting it into the runtime cache,
 * replaying logs, reconciling recovery, repairing tool calls, or persisting.
 * Live state is returned as a readonly view; callers must snapshot the fields
 * they inspect because an active run may continue updating it.
 */
export async function loadConversationStateReadOnly(
  conversationId: string,
): Promise<Readonly<SharedState> | undefined> {
  try {
    assertSafeCollectionId(conversationId);
  } catch {
    log.warn('Rejected unsafe conversationId on read-only load', { conversationId });
    return undefined;
  }

  const live = FlowExecutor.conversationStates.get(conversationId);
  if (live) {
    log.debug('Read state from memory without cache mutation', { conversationId });
    return live;
  }

  const storageKey = `conversations/${conversationId}` as StorageKey;
  try {
    const state = await loadItemBackend<SharedState | undefined>(storageKey, undefined);
    return state || undefined;
  } catch (error) {
    log.warn('Error reading conversation state without recovery', { conversationId, error });
    return undefined;
  }
}

/**
 * Load a conversation's SharedState, preferring the in-memory map and falling
 * back to durable storage (adopting the loaded state into the map so subsequent
 * lookups hit memory). Returns undefined when the conversation is unknown or a
 * storage read fails.
 *
 * Centralizes the memory→storage lookup that the resume/control routes
 * (respond, debug/step, debug/continue, breakpoints, edit-state) each repeated.
 * NOTE: the cancel route deliberately keeps its own load (it treats a storage
 * read error as a hard 500 rather than "not found"), so it does not use this.
 *
 * Issue #413: the durable half is COALESCED per conversation id. Once the bounded
 * cache may evict a completed conversation, several control routes can miss at
 * the same instant; without coalescing each would independently replay the log
 * and re-persist the same dangling-tool repair.
 */
export async function loadConversationState(conversationId: string): Promise<SharedState | undefined> {
  // Path-traversal guard (issue #126): the conversationId becomes a filesystem
  // path via getFilePath(). Reject unsafe ids as "not found" to preserve the
  // existing undefined-on-failure contract for callers.
  try {
    assertSafeCollectionId(conversationId);
  } catch {
    log.warn('Rejected unsafe conversationId on load', { conversationId });
    return undefined;
  }
  if (FlowExecutor.conversationStates.has(conversationId)) {
    log.debug('Loaded state from memory', { conversationId });
    noteRead(conversationId, true);
    return FlowExecutor.conversationStates.get(conversationId);
  }
  noteRead(conversationId, false);
  return coalesceLoad(conversationId, () => loadFromDurableStorage(conversationId));
}

/**
 * The durable half of the load: snapshot -> conversation-log replay ->
 * interrupted-recovery reconciliation -> dangling-tool repair -> cache adoption.
 * Extracted so `coalesceLoad` can guarantee exactly one execution per id.
 */
async function loadFromDurableStorage(conversationId: string): Promise<SharedState | undefined> {
  const storageKey = `conversations/${conversationId}` as StorageKey;
  try {
    const state = await loadItemBackend<SharedState | undefined>(storageKey, undefined);
    if (state) {
      log.debug('Loaded state from storage', { conversationId });
      // Persona snapshots deliberately omit their runtime capability. A read or
      // legacy control route may inspect that durable projection, but it must
      // never replay logs, classify interruption, repair tools, or persist a
      // replacement snapshot without first reacquiring the owning Activity.
      // The Persona dispatcher installs authority before runFlow performs these
      // recovery steps.
      if (state.personaAttribution && !state.executionAuthority) {
        FlowExecutor.conversationStates.set(conversationId, state);
        noteWrite(conversationId, state);
        return state;
      }
      // Per-step durability lives in the append-only log; the snapshot is only
      // written at run boundaries. Fold in anything the snapshot missed.
      await recoverMessagesFromLog(state);
      // Wire artifacts are derived metadata. Stale or cross-conversation records
      // are ignored; they are never used to repair or replace canonical messages.
      state.compactionState = validateCompactionState(
        state.compactionState,
        conversationId,
        state.messages,
      );
      // Issue #355: a persisted running record owned by a prior process did not
      // reach a terminal boundary. Reclassify it before any resume/control route
      // can accidentally treat it as live. Legacy states without owner metadata
      // remain untouched.
      await reconcileInterruptedRecovery(storageKey, state);
      // Issue #256: a crash mid-tool leaves an assistant tool_calls turn with no
      // matching role:'tool' result, which every provider 400s on. Heal it on
      // first load (covers /respond, /approvals, /debug/*, /edit-state) so the
      // conversation is well-formed before any request is built. Persist the
      // synthetic results to the append-only log AND back to the snapshot so the
      // repair survives even if no runFlow follows.
      try {
        const repaired = repairDanglingToolCalls(state);
        if (repaired.length) {
          log.info('Repaired dangling tool call(s) on load', { conversationId, count: repaired.length });
          markDanglingToolEffectsUnknown(state);
          await appendRawForState(state, [
            ...repaired.map(m => ({ type: 'message' as const, message: m })),
            { type: 'recovery:checkpoint', checkpoint: state.recovery!.currentCheckpoint! },
            { type: 'recovery:transition', recovery: { ...state.recovery! } },
          ]);
          await persistConversationState(storageKey, state);
        }
      } catch (repairError) {
        log.warn('Failed to repair dangling tool calls on load; continuing', { conversationId, repairError });
      }
      FlowExecutor.conversationStates.set(conversationId, state);
      noteWrite(conversationId, state);
      return state;
    }
  } catch (error) {
    log.warn('Error loading conversation state from storage', { conversationId, error });
  }
  return undefined;
}
