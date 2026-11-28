// Saves one goal per agent chat and changes it one writer at a time.
import type { ChatGoal } from '@/shared/types/chatGoal';
import { deleteCollectionItem, listCollectionItems, loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { retryTransientFileOperation } from '@/utils/transientFileRetry';
import { workspaceCacheKey } from '@/utils/workspace';

const COLLECTION = 'chat-goals';

const store = globalThis as typeof globalThis & { __flujoChatGoalChains?: Map<string, Promise<unknown>> };

function chains(): Map<string, Promise<unknown>> {
  store.__flujoChatGoalChains ??= new Map();
  return store.__flujoChatGoalChains;
}

export async function loadChatGoal(conversationId: string): Promise<ChatGoal | null> {
  const goal = await retryTransientFileOperation(
    () => loadCollectionItem<ChatGoal | null>(COLLECTION, conversationId, null),
    { label: 'chat-goal-read' },
  );
  return goal && typeof goal === 'object' && goal.conversationId === conversationId ? goal : null;
}

/** Every saved goal of the current workspace. An unreadable file is skipped, never fatal. */
export async function listChatGoals(): Promise<ChatGoal[]> {
  const goals = await listCollectionItems<ChatGoal>(COLLECTION);
  return goals.filter((goal) => goal && typeof goal === 'object' && typeof goal.conversationId === 'string');
}

/**
 * Change a chat's goal from its latest saved value. `change` returns the new
 * goal, `null` to remove it, or `undefined` to leave it as it is. Changes to
 * one chat's goal run one after another, so a pause typed while FLUJO starts
 * the next turn is never lost; a failed change does not block later ones.
 */
export async function mutateChatGoal<T>(
  conversationId: string,
  change: (goal: ChatGoal | null) => { goal?: ChatGoal | null; result: T } | Promise<{ goal?: ChatGoal | null; result: T }>,
): Promise<T> {
  const key = workspaceCacheKey('chat-goal', conversationId);
  const previous = chains().get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const current = await loadChatGoal(conversationId);
    const { goal, result } = await change(current);
    if (goal === null && current) {
      await retryTransientFileOperation(() => deleteCollectionItem(COLLECTION, conversationId), { label: 'chat-goal-delete' });
    } else if (goal) {
      await retryTransientFileOperation(() => saveCollectionItem(COLLECTION, conversationId, goal), { label: 'chat-goal-save' });
    }
    return result;
  });
  chains().set(key, run);
  try {
    return await run;
  } finally {
    if (chains().get(key) === run) chains().delete(key);
  }
}

/** Hold the goal. `person` waits for `/goal resume`; `stopped` (Stop) goes on with the person's next message. */
export async function pauseChatGoal(conversationId: string, reason: 'person' | 'stopped'): Promise<ChatGoal | null> {
  return mutateChatGoal(conversationId, (goal) => {
    if (!goal || goal.state !== 'active') return { result: goal };
    const now = Date.now();
    const next: ChatGoal = { ...goal, state: 'paused', pause: { reason, at: now }, retryAt: undefined, updatedAt: now };
    return { goal: next, result: next };
  });
}

/** Remove the goal. A goal turn that is already running finishes normally. */
export async function clearChatGoal(conversationId: string): Promise<ChatGoal | null> {
  return mutateChatGoal(conversationId, (goal) => ({ goal: null, result: goal }));
}
