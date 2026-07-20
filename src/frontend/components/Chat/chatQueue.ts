// Pure, framework-free helpers for the chat message queue (issue #177).
//
// While a conversation has a run in flight the user can keep typing and submit
// follow-up messages; instead of being sent immediately (which the backend
// would happily run concurrently) they are parked in a per-conversation FIFO
// queue and auto-sent, one at a time, once the conversation becomes idle and
// unblocked. Keeping this logic pure (no React) makes it trivially unit-testable
// and keeps the Chat component wiring thin.

import type { Attachment } from './index';

// A message the user submitted while a run was already in progress. `nodeOverride`
// is captured at enqueue time so the one-shot node pick applies only to this
// message and never leaks to later ones (mirrors the live `nodeOverride` state).
export interface QueuedMessage {
  id: string;
  content: string;
  attachments: Attachment[];
  nodeOverride: string | null;
  timestamp: number;
}

// Queues keyed by conversation id. A conversation with no queued messages simply
// has no key (or an empty array).
export type QueueMap = Record<string, QueuedMessage[]>;

/** Return the (possibly empty) queue for a conversation. Never mutates. */
export function getQueue(queues: QueueMap, conversationId: string): QueuedMessage[] {
  return queues[conversationId] ?? [];
}

/** The head (next-to-send) message of a conversation's queue, if any. */
export function peekQueue(queues: QueueMap, conversationId: string): QueuedMessage | undefined {
  return getQueue(queues, conversationId)[0];
}

/** Append a message to the tail of a conversation's queue (immutably). */
export function enqueue(queues: QueueMap, conversationId: string, message: QueuedMessage): QueueMap {
  return {
    ...queues,
    [conversationId]: [...getQueue(queues, conversationId), message],
  };
}

/**
 * Remove and return the head of a conversation's queue (immutably). If the
 * queue becomes empty the key is dropped so `queues` stays tidy. Returns the
 * new map and the removed head (undefined when the queue was already empty).
 */
export function dequeue(
  queues: QueueMap,
  conversationId: string,
): { queues: QueueMap; head: QueuedMessage | undefined } {
  const current = getQueue(queues, conversationId);
  if (current.length === 0) {
    return { queues, head: undefined };
  }
  const [head, ...rest] = current;
  const next: QueueMap = { ...queues };
  if (rest.length > 0) {
    next[conversationId] = rest;
  } else {
    delete next[conversationId];
  }
  return { queues: next, head };
}

/** Drop a conversation's entire queue (e.g. on delete). Immutable. */
export function clearQueue(queues: QueueMap, conversationId: string): QueueMap {
  if (!(conversationId in queues)) return queues;
  const next = { ...queues };
  delete next[conversationId];
  return next;
}

/** Remove a single queued message by id (e.g. the user cancels a queued bubble). */
export function removeQueued(queues: QueueMap, conversationId: string, messageId: string): QueueMap {
  const current = getQueue(queues, conversationId);
  const filtered = current.filter(m => m.id !== messageId);
  if (filtered.length === current.length) return queues;
  const next = { ...queues };
  if (filtered.length > 0) {
    next[conversationId] = filtered;
  } else {
    delete next[conversationId];
  }
  return next;
}

// Inputs that gate whether the queue may auto-drain the next message.
export interface DrainGate {
  // A run is currently in flight for the conversation.
  running: boolean;
  // The conversation is waiting on tool-call approval.
  pendingApproval: boolean;
  // The conversation is paused in the debugger.
  debugPaused: boolean;
  // The last run ended in an error — halt draining and let the user decide.
  hasError: boolean;
  // The user just stopped the conversation this session — halt draining.
  stopped: boolean;
}

/**
 * Whether the next queued message may be auto-sent now. The queue only drains
 * when the conversation is genuinely idle and unblocked; a run in flight, a
 * pending approval, a debugger pause, an errored run, or a user Stop all hold
 * the queue.
 */
export function canDrain(gate: DrainGate): boolean {
  return !gate.running && !gate.pendingApproval && !gate.debugPaused && !gate.hasError && !gate.stopped;
}
