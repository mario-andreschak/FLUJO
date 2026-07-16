/**
 * Regression tests for the "deleted conversation reappears" bug.
 *
 * Root cause: deleting a conversation only unlinked its file and dropped the
 * in-memory map entry — the in-flight run kept its closure reference to the
 * SharedState and re-persisted it at the next run boundary, resurrecting the
 * file (and the sidebar entry).
 *
 * The fix: the DELETE handler tombstones the id (markConversationDeleted) and
 * the persistence chokepoint (persistConversationState) refuses tombstoned
 * states, exactly like it refuses ephemeral ones.
 */
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async () => {}),
  loadItem: jest.fn(async () => undefined),
}));

import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import {
  markConversationDeleted,
  unmarkConversationDeleted,
  isConversationDeleted,
} from '@/backend/execution/flow/cancellation';
import { saveItem } from '@/utils/storage/backend';
import type { SharedState } from '@/backend/execution/flow/types';
import type { StorageKey } from '@/shared/types/storage';

const CONV_ID = 'conv-tombstone-1';
const KEY = `conversations/${CONV_ID}` as StorageKey;

const makeState = (): SharedState =>
  ({
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: CONV_ID,
    status: 'running',
    title: 'T',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SharedState);

beforeEach(() => {
  (saveItem as jest.Mock).mockClear();
  unmarkConversationDeleted(CONV_ID);
});

describe('deleted-conversation tombstone', () => {
  it('persists normally when the conversation is not tombstoned', async () => {
    await persistConversationState(KEY, makeState());
    expect(saveItem).toHaveBeenCalledTimes(1);
  });

  it('refuses to persist a tombstoned conversation (no resurrection)', async () => {
    markConversationDeleted(CONV_ID);
    expect(isConversationDeleted(CONV_ID)).toBe(true);

    await persistConversationState(KEY, makeState());
    expect(saveItem).not.toHaveBeenCalled();
  });

  it('persists again once the tombstone is cleared (id re-created)', async () => {
    markConversationDeleted(CONV_ID);
    unmarkConversationDeleted(CONV_ID);

    await persistConversationState(KEY, makeState());
    expect(saveItem).toHaveBeenCalledTimes(1);
  });
});
