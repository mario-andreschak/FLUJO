import { FlowExecutor } from './FlowExecutor';
import { loadItem as loadItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { SharedState } from './types';
import { createLogger } from '@/utils/logger';

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
  if (FlowExecutor.conversationStates.has(conversationId)) {
    log.debug('Loaded state from memory', { conversationId });
    return FlowExecutor.conversationStates.get(conversationId);
  }
  const storageKey = `conversations/${conversationId}` as StorageKey;
  try {
    const state = await loadItemBackend<SharedState>(storageKey, undefined as any);
    if (state) {
      log.debug('Loaded state from storage', { conversationId });
      FlowExecutor.conversationStates.set(conversationId, state);
      return state;
    }
  } catch (error) {
    log.warn('Error loading conversation state from storage', { conversationId, error });
  }
  return undefined;
}
