import { SharedState } from './types';
import { MAX_SUBFLOW_DEPTH } from './constants';

/**
 * Run-tree cancellation + deleted-conversation tombstones.
 *
 * Cancellation is a per-conversation flag (SharedState.isCancelled) checked by
 * runFlow's loop guard. A subflow child runs with its OWN ephemeral SharedState,
 * so the parent's flag never reaches it directly — instead the child records its
 * parent's conversation id (SharedState.parentRunId) and the guard walks the
 * ancestor chain through the live state registry (issue #109). Kept as a pure
 * function over the registry so both runFlow and SubflowNode's worker pool can
 * use it without import cycles (this module only depends on leaf modules).
 */
export function isCancelledByAncestry(
  startConversationId: string | undefined,
  states: ReadonlyMap<string, SharedState>,
): boolean {
  let currentId = startConversationId;
  const visited = new Set<string>();
  // The chain is bounded by the subflow depth cap; +1 headroom for the top run.
  for (let hops = 0; hops <= MAX_SUBFLOW_DEPTH + 1; hops++) {
    if (!currentId || visited.has(currentId)) return false;
    visited.add(currentId);
    const state = states.get(currentId);
    if (!state) return false;
    if (state.isCancelled) return true;
    currentId = state.parentRunId;
  }
  return false;
}

/**
 * Tombstones for deleted conversations.
 *
 * Deleting a conversation while its flow is still executing left a race: the
 * in-flight run holds a closure reference to its SharedState and re-persists it
 * at the next run boundary, resurrecting the just-deleted file. The DELETE
 * handler marks the id here; persistConversationState and the conversation-log
 * tap refuse tombstoned ids, and runFlow drops the in-memory state at run end
 * instead of re-registering it. Cleared if the same id is ever re-created.
 */
const deletedConversationIds = new Set<string>();

export function markConversationDeleted(conversationId: string): void {
  deletedConversationIds.add(conversationId);
}

export function unmarkConversationDeleted(conversationId: string): void {
  deletedConversationIds.delete(conversationId);
}

export function isConversationDeleted(conversationId: string | undefined): boolean {
  return !!conversationId && deletedConversationIds.has(conversationId);
}
