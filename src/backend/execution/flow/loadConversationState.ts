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

const log = createLogger('backend/execution/flow/loadConversationState');

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
    return FlowExecutor.conversationStates.get(conversationId);
  }
  const storageKey = `conversations/${conversationId}` as StorageKey;
  try {
    const state = await loadItemBackend<SharedState>(storageKey, undefined as any);
    if (state) {
      log.debug('Loaded state from storage', { conversationId });
      // Per-step durability lives in the append-only log; the snapshot is only
      // written at run boundaries. Fold in anything the snapshot missed.
      await recoverMessagesFromLog(state);
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
      return state;
    }
  } catch (error) {
    log.warn('Error loading conversation state from storage', { conversationId, error });
  }
  return undefined;
}
