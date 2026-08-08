import { AsyncLocalStorage } from 'async_hooks';

import { workspaceCacheKey } from '@/utils/workspace';

interface ConversationExecutionContext {
  heldKeys: Set<string>;
}

declare global {
  var __flujoConversationExecutionLocks: Map<string, Promise<void>> | undefined;
  var __flujoConversationExecutionContext:
    | AsyncLocalStorage<ConversationExecutionContext>
    | undefined;
}

const locks = globalThis.__flujoConversationExecutionLocks
  ?? (globalThis.__flujoConversationExecutionLocks = new Map());
const context = globalThis.__flujoConversationExecutionContext
  ?? (globalThis.__flujoConversationExecutionContext = new AsyncLocalStorage());

function lockKey(conversationId: string): string {
  return workspaceCacheKey('conversation-execution-lock', conversationId);
}

/**
 * Serialize every execution which can mutate one durable conversation.
 *
 * The async-local ownership marker makes this re-entrant: MeetingEngine can
 * hold the lease while it prepares a participant inbox, then call runFlow,
 * whose public boundary acquires the same lease without deadlocking.
 */
export async function withConversationExecutionLock<T>(
  conversationId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = lockKey(conversationId);
  const inherited = context.getStore();
  if (inherited?.heldKeys.has(key)) return task();

  const predecessor = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.catch(() => undefined).then(() => current);
  locks.set(key, tail);

  await predecessor.catch(() => undefined);
  const heldKeys = new Set(inherited?.heldKeys ?? []);
  heldKeys.add(key);
  try {
    return await context.run({ heldKeys }, task);
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function isConversationExecutionLocked(conversationId: string): boolean {
  return locks.has(lockKey(conversationId));
}
