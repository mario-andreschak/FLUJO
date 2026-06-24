import { FlujoChatMessage } from '@/shared/types/chat';

/**
 * Insert or replace a message in a conversation's message array, keyed by `id`.
 *
 * Used for incremental persistence of messages streamed from a self-orchestrating
 * adapter (Claude subscription): the same message is first streamed live mid-run
 * and later materialized into the conversation at end-of-run. Keying on `id`
 * makes folding it in idempotent — calling this repeatedly with the same message
 * converges instead of duplicating. Mutates `messages` in place and returns it.
 */
export function upsertMessageById(
  messages: FlujoChatMessage[],
  message: FlujoChatMessage
): FlujoChatMessage[] {
  const idx = messages.findIndex(m => m.id === message.id);
  if (idx >= 0) {
    messages[idx] = message;
  } else {
    messages.push(message);
  }
  return messages;
}
