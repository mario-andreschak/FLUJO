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
