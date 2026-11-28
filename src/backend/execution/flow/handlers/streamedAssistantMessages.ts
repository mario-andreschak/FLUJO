// Messages a self-orchestrating adapter streams while it runs: fold them into live state, and take back failed prose.
import { getConversationStates } from '../conversationStateRegistry';
import { FlujoChatMessage } from '@/shared/types/chat';
import { appendRawForState } from '@/backend/execution/flow/conversationLog';
import { upsertMessageById } from '@/backend/execution/flow/conversationMessages';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/flow/execution/handlers/streamedAssistantMessages');

/**
 * Fold a message streamed from a self-orchestrating adapter (Claude
 * subscription) into the conversation's live in-memory SharedState AS it is
 * produced (keyed by id, so it is idempotent w.r.t. the same message being
 * materialized again at end-of-run).
 *
 * Crash/error safety no longer needs a full-file state write here: the
 * caller emits the same message on the event bus immediately before this
 * call, and the bus tap APPENDS it to the conversation log — if the run
 * dies mid-loop, tool calls/results that already executed (SAP objects
 * created, tickets opened, ...) are recovered from the log when the
 * snapshot is next loaded (recoverMessagesFromLog). Dropping the write
 * removed the per-streamed-message O(file size) rewrite on long agentic
 * runs (execution-core v2 Phase 3).
 *
 * Best-effort: it must never throw into (or block) the streaming path.
 */
export function persistStreamedMessage(conversationId: string, message: FlujoChatMessage): void {
  try {
    const state = getConversationStates().get(conversationId);
    if (!state || !Array.isArray(state.messages)) {
      // Conversation not tracked in memory yet; the normal end-of-run save covers it.
      return;
    }
    upsertMessageById(state.messages, message);
    state.updatedAt = Date.now();
  } catch (err) {
    log.warn(`Failed to fold streamed message into conversation ${conversationId}`, { err });
  }
}

/** A live Claude transcript assistant message is prose only when it has text
 * and is not the assistant half of a tool-call pair. */
export function isStreamedAssistantProse(message: FlujoChatMessage): boolean {
  const assistant = message as Extract<FlujoChatMessage, { role: 'assistant' }>;
  return assistant.role === 'assistant'
    && typeof assistant.content === 'string'
    && assistant.content.length > 0
    && !assistant.tool_calls?.length;
}

/**
 * Compensate a failed self-orchestrating model attempt. Streamed prose has
 * already reached the append-only log, so remove it from the live projection
 * and append matching log-only removals. Tool calls/results are deliberately
 * never tracked here and therefore survive a failed attempt.
 */
export async function removeFailedStreamedAssistantProse(
  conversationId: string | undefined,
  messageIds: ReadonlySet<string>
): Promise<void> {
  if (!conversationId || messageIds.size === 0) return;
  try {
    // The dependency-free registry avoids the FlowExecutor -> ProcessNode ->
    // ModelHandler import cycle (a lazy require failed in production, #1319).
    const state = getConversationStates().get(conversationId);
    if (!state || !Array.isArray(state.messages)) return;

    // Only compensate messages still present. This makes repeated failure
    // handling idempotent: after the first pass neither state nor log changes.
    const removals = [...messageIds].filter((id) =>
      state.messages.some((message: FlujoChatMessage) => message.id === id)
    );
    if (removals.length === 0) return;
    const removalSet = new Set(removals);
    for (let index = state.messages.length - 1; index >= 0; index--) {
      if (removalSet.has(state.messages[index].id)) state.messages.splice(index, 1);
    }
    state.updatedAt = Date.now();
    await appendRawForState(state, removals.map((messageId) => ({ type: 'message:removed', messageId })));
  } catch (err) {
    log.warn(`Failed to compensate streamed prose for failed conversation ${conversationId}`, { err });
  }
}
