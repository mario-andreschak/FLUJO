export const CONVERSATION_PINS_PREFERENCE = 'flujo-ui:chat-sidebar:pinned';

interface ConversationLineage {
  id: string;
  parentConversationId?: string | null;
  rootConversationId?: string | null;
}

/** Pins follow descendants, including children created after the pin was saved. */
export function collectPinnedConversationIds(
  conversations: ConversationLineage[],
  pinnedIds: readonly string[],
): Set<string> {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const childrenByParent = new Map<string, string[]>();
  for (const conversation of byId.values()) {
    let parentId = conversation.parentConversationId;
    if (!parentId || parentId === conversation.id) continue;
    // Match the tree's root fallback when an intermediate parent is unavailable.
    const root = conversation.rootConversationId ? byId.get(conversation.rootConversationId) : undefined;
    if (!byId.has(parentId) && root && (!root.parentConversationId || root.parentConversationId === root.id)) {
      parentId = root.id;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(conversation.id);
    childrenByParent.set(parentId, children);
  }
  const pinned = new Set<string>();
  // Deleted anchors must not leave descendants pinned with no reachable unpin action.
  const pending = pinnedIds.filter((id) => byId.has(id));
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (pinned.has(id)) continue;
    pinned.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  return pinned;
}
