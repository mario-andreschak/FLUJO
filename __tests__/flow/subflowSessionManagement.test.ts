import {
  acquireSessionExecution,
  activeSessionCoordinatorCount,
  normalizeSessionKey,
  resolveSessionConversationId,
  resolveSessionIdentity,
  updateSessionRegistry,
} from '@/backend/execution/flow/sessionManagement';
import type { SharedState } from '@/backend/execution/flow/types';

function parentState(): SharedState {
  return {
    trackingInfo: { executionId: 'exec', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'parent-flow',
    conversationId: 'parent-conversation',
    logicalRunId: 'logical-run-1',
    title: 'Parent',
    createdAt: 1,
    updatedAt: 1,
  } as SharedState;
}

describe('resumable Subflow session registry', () => {
  it('builds run- and key-scoped identities without allowing a missing parent run', () => {
    expect(resolveSessionIdentity('run-1', 'sub', 'per-run', undefined)).toBe('run-1::sub::');
    expect(resolveSessionIdentity('run-1', 'sub', 'per-key', 'writer-1')).toBe('run-1::sub::writer-1');
    expect(resolveSessionIdentity(undefined, 'sub', 'per-run', undefined)).toBeUndefined();
    expect(resolveSessionIdentity('run-1', 'sub', 'per-key', undefined)).toBeUndefined();
  });

  it('accepts bounded opaque keys while rejecting empty and unresolved values', () => {
    expect(normalizeSessionKey('  scene_2:review.v1  ')).toBe('scene_2:review.v1');
    expect(normalizeSessionKey('contains spaces')).toBe('contains spaces');
    expect(normalizeSessionKey('../路径/🎬')).toBe('../路径/🎬');
    expect(normalizeSessionKey('  ')).toBeUndefined();
    expect(normalizeSessionKey('{{scene_id}}')).toBeUndefined();
    expect(normalizeSessionKey('x'.repeat(129))).toBeUndefined();
  });

  it('encodes opaque key components so delimiters and Unicode cannot collide', () => {
    const delimited = resolveSessionIdentity('run-1', 'sub', 'per-key', 'a::b');
    const unicode = resolveSessionIdentity('run-1', 'sub', 'per-key', '场景/🎬');
    expect(delimited).toBe('run-1::sub::a%3A%3Ab');
    expect(unicode).toBe(`run-1::sub::${encodeURIComponent('场景/🎬')}`);
    expect(delimited).not.toBe(unicode);
  });

  it('reuses one conversation for the same key and keeps different keys independent', () => {
    const state = parentState();
    const firstIdentity = resolveSessionIdentity('logical-run-1', 'sub', 'per-key', 'writer-a')!;
    const otherIdentity = resolveSessionIdentity('logical-run-1', 'sub', 'per-key', 'writer-b')!;

    const first = resolveSessionConversationId(state, firstIdentity, 'sub', 'writer-a');
    expect(first).toMatchObject({ resumedVisit: false, sessionVisit: 1 });
    updateSessionRegistry(state, firstIdentity, 'completed');

    const resumed = resolveSessionConversationId(state, firstIdentity, 'sub', 'writer-a');
    const other = resolveSessionConversationId(state, otherIdentity, 'sub', 'writer-b');

    expect(resumed).toEqual({
      conversationId: first.conversationId,
      resumedVisit: true,
      sessionVisit: 2,
    });
    expect(other).toMatchObject({ resumedVisit: false, sessionVisit: 1 });
    expect(other.conversationId).not.toBe(first.conversationId);
    expect(state.subflowSessions?.[firstIdentity]).toMatchObject({
      sessionKey: 'writer-a',
      visits: 1,
      status: 'running',
    });
  });

  it('serialises cold-start acquisition in FIFO order and removes the idle coordinator', async () => {
    const state = parentState();
    const identity = resolveSessionIdentity('logical-run-1', 'sub', 'per-key', 'shared')!;
    const firstRelease = await acquireSessionExecution(identity);
    const order: number[] = [1];
    const second = acquireSessionExecution(identity).then((release) => {
      order.push(2);
      const result = resolveSessionConversationId(state, identity, 'sub', 'shared');
      release();
      return result;
    });

    const first = resolveSessionConversationId(state, identity, 'sub', 'shared');
    updateSessionRegistry(state, identity, 'completed');
    firstRelease();
    const resumed = await second;

    expect(order).toEqual([1, 2]);
    expect(resumed).toEqual({
      conversationId: first.conversationId,
      resumedVisit: true,
      sessionVisit: 2,
    });
    expect(activeSessionCoordinatorCount()).toBe(0);
  });
});
