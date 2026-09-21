import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as first from '@/backend/execution/flow/conversationLog';
import type { SharedState } from '@/backend/execution/flow/types';

it('shares sequence allocation across independently evaluated route bundles', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-log-bundles-'));
  const prior = first._setConversationLogDirForTests(directory);
  try {
    let second!: typeof first;
    jest.isolateModules(() => { second = jest.requireActual('@/backend/execution/flow/conversationLog'); });
    second._setConversationLogDirForTests(directory);
    const state = {
      conversationId: 'multiple-route-bundles', flowId: 'flow', title: 'Bundle regression',
      messages: [], trackingInfo: { executionId: 'x', startTime: 1, nodeExecutionTracker: [] }, createdAt: 1, updatedAt: 1,
    } as SharedState;
    const id = state.conversationId!;
    // Seed both modules before the first append, reproducing the stale counter.
    expect(await first.latestSequence(id)).toBe(-1);
    expect(await second.latestSequence(id)).toBe(-1);
    await first.appendRawForState(state, [{ type: 'message', message: { role: 'user', content: 'one', id: 'u1', timestamp: 1 } }]);
    await second.appendRawForState(state, [{ type: 'message', message: { role: 'assistant', content: 'two', id: 'a1', timestamp: 2 } }]);
    await first.appendRawForState(state, [{ type: 'message', message: { role: 'user', content: 'three', id: 'u2', timestamp: 3 } }]);
    await second.flushConversationLog(id);
    expect((await first.readConversationLog(id))?.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(await second.latestSequence(id)).toBe(2);
  } finally {
    first._setConversationLogDirForTests(prior);
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^flujo-log-bundles-/);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
