import type { FlujoChatMessage } from '@/shared/types/chat';

/**
 * Mid-run steering inbox: user messages submitted while a run is ALREADY in
 * flight, to be folded into the live run at its next safe boundary instead of
 * waiting for the whole run to finish.
 *
 * Why this exists: the chat message queue (issue #177) only auto-sends a parked
 * message once the conversation goes idle, so a correction typed two seconds
 * into a five-minute agentic run lands five minutes too late — and starts a
 * fresh run rather than redirecting the one that is going the wrong way. The
 * point of typing mid-run is to intervene, so the message has to reach the
 * model that is currently working.
 *
 * The inbox is deliberately dumb: routes append, the run loop drains. All the
 * policy — *when* it is safe to fold a message in — lives in runFlow, because
 * only the loop knows whether the transcript is currently well-formed (an
 * assistant `tool_calls` turn whose results have not been appended yet must
 * never be split by a user message; every provider 400s on that shape).
 *
 * Module-level singleton backed by globalThis, mirroring toolApprovalRegistry
 * and the ExecutionEventBus, so a Next.js dev hot-reload (or a second module
 * instance across the route/runtime boundary) does not silently drop messages
 * the user has already sent.
 */

const globalForInbox = globalThis as unknown as {
  __flujoSteeringInbox?: Map<string, FlujoChatMessage[]>;
};
const inbox: Map<string, FlujoChatMessage[]> =
  globalForInbox.__flujoSteeringInbox ?? (globalForInbox.__flujoSteeringInbox = new Map());

/** Append a steering message to the tail of a conversation's inbox (FIFO). */
export function enqueueSteeringMessage(conversationId: string, message: FlujoChatMessage): void {
  const existing = inbox.get(conversationId);
  if (existing) {
    existing.push(message);
  } else {
    inbox.set(conversationId, [message]);
  }
}

/** How many messages are waiting. Cheap enough to call every loop iteration. */
export function steeringCount(conversationId: string): number {
  return inbox.get(conversationId)?.length ?? 0;
}

/** Non-destructive look at the waiting messages (empty array when none). */
export function peekSteeringMessages(conversationId: string): readonly FlujoChatMessage[] {
  return inbox.get(conversationId) ?? [];
}

/**
 * Remove and return every waiting message, in submission order. The caller owns
 * them from here — if it cannot use them it must put them back (see
 * requeueSteeringMessages), because nothing else holds a reference.
 */
export function takeSteeringMessages(conversationId: string): FlujoChatMessage[] {
  const pending = inbox.get(conversationId);
  if (!pending || pending.length === 0) return [];
  inbox.delete(conversationId);
  return pending;
}

/**
 * Put messages back at the FRONT of the inbox, preserving their relative order
 * and staying ahead of anything that arrived while the caller held them. Used
 * when a drain has to be abandoned (e.g. the run errored before the messages
 * could be folded in) so a steering message is never silently lost.
 */
export function requeueSteeringMessages(conversationId: string, messages: FlujoChatMessage[]): void {
  if (messages.length === 0) return;
  const later = inbox.get(conversationId) ?? [];
  inbox.set(conversationId, [...messages, ...later]);
}

/** Drop a conversation's whole inbox (cancel / delete). */
export function clearSteeringInbox(conversationId: string): void {
  inbox.delete(conversationId);
}
