import { randomUUID } from 'crypto';

import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';

describe('conversation execution lock', () => {
  it('serializes mutations of one conversation', async () => {
    const conversationId = `conversation-${randomUUID()}`;
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withConversationExecutionLock(conversationId, async () => {
      order.push('first:start');
      firstStarted();
      await gate;
      order.push('first:end');
    });
    await started;
    const second = withConversationExecutionLock(conversationId, async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('is re-entrant for the current async owner', async () => {
    const conversationId = `conversation-${randomUUID()}`;
    const result = await withConversationExecutionLock(conversationId, () =>
      withConversationExecutionLock(conversationId, async () => 'done'));
    expect(result).toBe('done');
  });
});
