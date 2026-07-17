/**
 * Unit tests for issue #126 at the two persistence choke points.
 *
 * persistConversationState() and loadConversationState() build a filesystem
 * path from the conversation id, so both must reject a traversing id:
 *  - persist: reject the write (rejected promise); saveItem must NOT be called.
 *  - load: treat an unsafe id as "not found" (return undefined) per its existing
 *    failure contract; loadItem must NOT be called.
 *
 * The backend is mocked (as in deletedConversationTombstone.test.ts) but keeps
 * the real assertSafeCollectionId regex so the guard is exercised for real.
 */
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async () => {}),
  loadItem: jest.fn(async () => undefined),
  assertSafeCollectionId: (id: string) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
    }
  },
}));

import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState } from '@/backend/execution/flow/types';
import type { StorageKey } from '@/shared/types/storage';

const VALID_ID = '123e4567-e89b-12d3-a456-426614174000';

const makeState = (conversationId: string): SharedState =>
  ({
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId,
    status: 'running',
    title: 'T',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState);

beforeEach(() => {
  (saveItem as jest.Mock).mockClear();
  (loadItem as jest.Mock).mockClear();
  FlowExecutor.conversationStates.clear();
});

describe('persistConversationState path-traversal guard (issue #126)', () => {
  it.each([
    'conversations/../encryption_key',
    'conversations/../models',
    'conversations/..',
    'conversations/a/b',
  ])('refuses to persist unsafe key %j (no write)', async (key) => {
    const badId = key.slice('conversations/'.length);
    await expect(
      persistConversationState(key as StorageKey, makeState(badId)),
    ).rejects.toThrow(/Unsafe collection item id/);
    expect(saveItem).not.toHaveBeenCalled();
  });

  it('persists a valid uuid id exactly once (round-trip unchanged)', async () => {
    await persistConversationState(`conversations/${VALID_ID}` as StorageKey, makeState(VALID_ID));
    expect(saveItem).toHaveBeenCalledTimes(1);
  });
});

describe('loadConversationState path-traversal guard (issue #126)', () => {
  it.each(['../encryption_key', '../models', '..', 'a/b'])(
    'returns undefined for unsafe id %j and never reads storage',
    async (badId) => {
      await expect(loadConversationState(badId)).resolves.toBeUndefined();
      expect(loadItem).not.toHaveBeenCalled();
    });

  it('performs a normal lookup for a valid uuid id', async () => {
    const state = makeState(VALID_ID);
    FlowExecutor.conversationStates.set(VALID_ID, state);
    await expect(loadConversationState(VALID_ID)).resolves.toBe(state);
  });
});
