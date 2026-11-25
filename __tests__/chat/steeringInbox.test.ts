import { runWithWorkspace } from '@/utils/workspace';
/**
 * The mid-run steering inbox: a per-conversation FIFO of user messages handed to
 * a run that is already in flight. It is deliberately dumb (routes append, the
 * run loop drains) — the only property that really matters is that a message the
 * user has already sent is never silently lost, including on the paths where the
 * run loop takes messages and then cannot use them.
 */
import {
  enqueueSteeringMessage,
  steeringCount,
  peekSteeringMessages,
  takeSteeringMessages,
  requeueSteeringMessages,
  clearSteeringInbox,
  subscribeSteeringMessages,
  withdrawSteeringMessage,
  watchSteeringDelivery,
  markSteeringDelivered,
} from '@/backend/execution/flow/steeringInbox';
import type { FlujoChatMessage } from '@/shared/types/chat';

const msg = (id: string): FlujoChatMessage =>
  ({ role: 'user', content: id, id, timestamp: 1, injected: true } as FlujoChatMessage);

const CONV = 'conv-inbox';
const OTHER = 'conv-other';

beforeEach(() => {
  clearSteeringInbox(CONV);
  clearSteeringInbox(OTHER);
});

describe('steeringInbox', () => {
  it('is empty for an unknown conversation', () => {
    expect(steeringCount(CONV)).toBe(0);
    expect(peekSteeringMessages(CONV)).toEqual([]);
    expect(takeSteeringMessages(CONV)).toEqual([]);
  });

  it('takes messages in submission order and empties the inbox', () => {
    enqueueSteeringMessage(CONV, msg('a'));
    enqueueSteeringMessage(CONV, msg('b'));
    expect(steeringCount(CONV)).toBe(2);

    expect(takeSteeringMessages(CONV).map((m) => m.id)).toEqual(['a', 'b']);
    expect(steeringCount(CONV)).toBe(0);
  });

  it('keeps conversations isolated', () => {
    enqueueSteeringMessage(CONV, msg('a'));
    enqueueSteeringMessage(OTHER, msg('b'));

    expect(takeSteeringMessages(CONV).map((m) => m.id)).toEqual(['a']);
    expect(takeSteeringMessages(OTHER).map((m) => m.id)).toEqual(['b']);
  });

  it('peeking does not consume', () => {
    enqueueSteeringMessage(CONV, msg('a'));

    expect(peekSteeringMessages(CONV).map((m) => m.id)).toEqual(['a']);
    expect(steeringCount(CONV)).toBe(1);
  });

  it('re-queues abandoned messages AHEAD of ones that arrived meanwhile', () => {
    // The run loop took 'a', failed to fold it in, and by then 'b' had landed.
    // 'a' was sent first and must still be delivered first.
    enqueueSteeringMessage(CONV, msg('a'));
    const taken = takeSteeringMessages(CONV);
    enqueueSteeringMessage(CONV, msg('b'));

    requeueSteeringMessages(CONV, taken);

    expect(takeSteeringMessages(CONV).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('re-queuing nothing is a no-op', () => {
    enqueueSteeringMessage(CONV, msg('a'));
    requeueSteeringMessages(CONV, []);
    expect(takeSteeringMessages(CONV).map((m) => m.id)).toEqual(['a']);
  });

  it('clearing drops everything waiting (stop discards a correction aimed at the stopped run)', () => {
    enqueueSteeringMessage(CONV, msg('a'));
    clearSteeringInbox(CONV);
    expect(steeringCount(CONV)).toBe(0);
  });
});


it('notifies subscribers only in their workspace and deduplicates requeued IDs', async () => {
  const notified = jest.fn();
  let unsubscribe!: () => void;
  runWithWorkspace('steering-test-a', () => {
    clearSteeringInbox(CONV);
    unsubscribe = subscribeSteeringMessages(CONV, notified);
  });
  runWithWorkspace('steering-test-b', () => { clearSteeringInbox(CONV); enqueueSteeringMessage(CONV, msg('other')); });
  await Promise.resolve();
  expect(notified).not.toHaveBeenCalled();
  runWithWorkspace('steering-test-a', () => {
    enqueueSteeringMessage(CONV, msg('stable'));
    enqueueSteeringMessage(CONV, msg('stable'));
    requeueSteeringMessages(CONV, [msg('stable')]);
    expect(peekSteeringMessages(CONV)).toHaveLength(1);
  });
  await Promise.resolve();
  expect(notified).toHaveBeenCalled();
  unsubscribe(); notified.mockClear();
  runWithWorkspace('steering-test-a', () => enqueueSteeringMessage(CONV, msg('late')));
  await Promise.resolve();
  expect(notified).not.toHaveBeenCalled();
});

describe('delivery tracking for senders that must know a message landed (#1401)', () => {
  it('takes back only a message that is still waiting', () => {
    enqueueSteeringMessage(CONV, msg('a'));
    enqueueSteeringMessage(CONV, msg('b'));
    expect(withdrawSteeringMessage(CONV, 'a')).toBe(true);
    expect(peekSteeringMessages(CONV).map(m => m.id)).toEqual(['b']);
    expect(withdrawSteeringMessage(CONV, 'a')).toBe(false);
    takeSteeringMessages(CONV);
    expect(withdrawSteeringMessage(CONV, 'b')).toBe(false);
  });

  it('wakes a watcher when its message is delivered, in the same workspace only', async () => {
    const watch = runWithWorkspace('steering-test-a', () => watchSteeringDelivery(CONV, 'x'));
    let delivered = false;
    void watch.delivered.then(() => { delivered = true; });
    runWithWorkspace('steering-test-b', () => markSteeringDelivered(CONV, ['x']));
    await Promise.resolve();
    expect(delivered).toBe(false);
    runWithWorkspace('steering-test-a', () => markSteeringDelivered(CONV, ['other', 'x']));
    await Promise.resolve();
    expect(delivered).toBe(true);
  });

  it('forgets a cancelled watch', async () => {
    const watch = watchSteeringDelivery(CONV, 'y');
    let delivered = false;
    void watch.delivered.then(() => { delivered = true; });
    watch.cancel();
    markSteeringDelivered(CONV, ['y']);
    await Promise.resolve();
    expect(delivered).toBe(false);
  });
});
