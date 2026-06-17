import { saveItem as saveItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { SharedState } from './types';

/**
 * Persist a conversation's SharedState to storage WITHOUT the debug execution
 * trace.
 *
 * The trace (`executionTrace`) re-snapshots state on every step, so persisting
 * it grows the conversation file with each step. It lives in memory
 * (`FlowExecutor.conversationStates`) and is shipped to the debugger in the live
 * response, so it does not need to be durable. Every code path that writes a
 * conversation's state should go through here so the on-disk file stays lean.
 */
export function persistConversationState(key: StorageKey, state: SharedState): Promise<void> {
  return saveItemBackend(key, { ...state, executionTrace: undefined });
}
