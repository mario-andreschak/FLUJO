import { saveItem as saveItemBackend, assertSafeCollectionId } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { SharedState } from './types';
import { isConversationDeleted } from './cancellation';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/execution/flow/persistConversationState');

/**
 * Persist a conversation's SharedState to storage WITHOUT the debug execution
 * trace.
 *
 * The trace (`executionTrace`) re-snapshots state on every step, so persisting
 * it grows the conversation file with each step. It lives in memory
 * (`FlowExecutor.conversationStates`) and is shipped to the debugger in the live
 * response, so it does not need to be durable. Every code path that writes a
 * conversation's state should go through here so the on-disk file stays lean.
 *
 * This is ALSO the single enforcement point for the ephemeral policy: a state
 * marked `ephemeral` (subflow child runs, future scheduler runs) is refused
 * outright, so it can never appear as a conversation in the chat sidebar. The
 * policy lives here, on the state, because per-call-site guards proved leaky —
 * an incremental persist path nobody remembered to guard wrote a subflow child
 * to disk. Do NOT add call-site `if (!ephemeral)` guards; they are redundant.
 */
export async function persistConversationState(key: StorageKey, state: SharedState): Promise<void> {
  // Path-traversal guard (issue #126): the key/id becomes a filesystem path via
  // getFilePath(), so an id like "../encryption_key" would escape db/conversations/
  // and yield an arbitrary .json write. Validate the id embedded in the key AND
  // state.conversationId before any write path (incl. the early returns below).
  const CONV_PREFIX = 'conversations/';
  const idFromKey = String(key).startsWith(CONV_PREFIX) ? String(key).slice(CONV_PREFIX.length) : String(key);
  assertSafeCollectionId(idFromKey);
  if (state.conversationId != null) assertSafeCollectionId(state.conversationId);

  if (state.ephemeral) {
    log.debug(`Refusing to persist ephemeral state (key ${key}); ephemeral runs never reach the conversations store.`);
    return Promise.resolve();
  }
  // Deleted-conversation tombstone: a run that was in flight when its
  // conversation was deleted must not re-write the file at its next run
  // boundary (that resurrected deleted conversations in the sidebar).
  if (isConversationDeleted(state.conversationId)) {
    log.info(`Refusing to persist state for deleted conversation ${state.conversationId} (key ${key}).`);
    return Promise.resolve();
  }
  return saveItemBackend(key, { ...state, executionTrace: undefined, emit: undefined });
}
