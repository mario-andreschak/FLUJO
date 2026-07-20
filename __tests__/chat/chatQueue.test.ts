/**
 * Tests for the chat message queue helpers (issue #177).
 *
 * These are the pure, framework-free primitives backing the Chat component's
 * per-conversation message queue: while a run is in flight the user can keep
 * typing and submit follow-ups, which are parked in a FIFO queue and auto-sent
 * one at a time once the conversation is idle and unblocked.
 */
import {
  QueueMap,
  QueuedMessage,
  enqueue,
  dequeue,
  clearQueue,
  removeQueued,
  getQueue,
  peekQueue,
  canDrain,
} from '@/frontend/components/Chat/chatQueue';

const msg = (id: string, content = id, nodeOverride: string | null = null): QueuedMessage => ({
  id,
  content,
  attachments: [],
  nodeOverride,
  timestamp: 0,
});

describe('chatQueue', () => {
  describe('enqueue / getQueue / peekQueue', () => {
    it('enqueues a message under its conversation id without mutating the input', () => {
      const start: QueueMap = {};
      const next = enqueue(start, 'c1', msg('a'));
      expect(start).toEqual({}); // immutable
      expect(getQueue(next, 'c1').map(m => m.id)).toEqual(['a']);
      expect(peekQueue(next, 'c1')?.id).toBe('a');
    });

    it('appends to the tail (FIFO order preserved)', () => {
      let q: QueueMap = {};
      q = enqueue(q, 'c1', msg('a'));
      q = enqueue(q, 'c1', msg('b'));
      q = enqueue(q, 'c1', msg('c'));
      expect(getQueue(q, 'c1').map(m => m.id)).toEqual(['a', 'b', 'c']);
      expect(peekQueue(q, 'c1')?.id).toBe('a');
    });

    it('keeps separate queues per conversation', () => {
      let q: QueueMap = {};
      q = enqueue(q, 'c1', msg('a'));
      q = enqueue(q, 'c2', msg('x'));
      expect(getQueue(q, 'c1').map(m => m.id)).toEqual(['a']);
      expect(getQueue(q, 'c2').map(m => m.id)).toEqual(['x']);
    });

    it('getQueue / peekQueue are safe for an unknown conversation', () => {
      expect(getQueue({}, 'nope')).toEqual([]);
      expect(peekQueue({}, 'nope')).toBeUndefined();
    });
  });

  describe('dequeue', () => {
    it('removes and returns the head in FIFO order', () => {
      let q: QueueMap = {};
      q = enqueue(q, 'c1', msg('a'));
      q = enqueue(q, 'c1', msg('b'));

      const first = dequeue(q, 'c1');
      expect(first.head?.id).toBe('a');
      expect(getQueue(first.queues, 'c1').map(m => m.id)).toEqual(['b']);

      const second = dequeue(first.queues, 'c1');
      expect(second.head?.id).toBe('b');
      expect(getQueue(second.queues, 'c1')).toEqual([]);
    });

    it('drops the key once the queue is emptied', () => {
      let q: QueueMap = {};
      q = enqueue(q, 'c1', msg('a'));
      const { queues } = dequeue(q, 'c1');
      expect('c1' in queues).toBe(false);
    });

    it('is a no-op (undefined head) for an empty/unknown queue', () => {
      const { queues, head } = dequeue({}, 'nope');
      expect(head).toBeUndefined();
      expect(queues).toEqual({});
    });

    it('does not mutate the input map', () => {
      const q = enqueue({}, 'c1', msg('a'));
      const snapshot = JSON.stringify(q);
      dequeue(q, 'c1');
      expect(JSON.stringify(q)).toBe(snapshot);
    });
  });

  describe('clearQueue', () => {
    it('drops the whole queue for a conversation', () => {
      let q: QueueMap = {};
      q = enqueue(q, 'c1', msg('a'));
      q = enqueue(q, 'c1', msg('b'));
      q = enqueue(q, 'c2', msg('x'));
      const cleared = clearQueue(q, 'c1');
      expect('c1' in cleared).toBe(false);
      expect(getQueue(cleared, 'c2').map(m => m.id)).toEqual(['x']);
    });

    it('returns the same reference when nothing to clear', () => {
      const q: QueueMap = {};
      expect(clearQueue(q, 'nope')).toBe(q);
    });
  });

  describe('removeQueued', () => {
    it('removes a single queued message by id, preserving order', () => {
      let q: QueueMap = {};
      q = enqueue(q, 'c1', msg('a'));
      q = enqueue(q, 'c1', msg('b'));
      q = enqueue(q, 'c1', msg('c'));
      const next = removeQueued(q, 'c1', 'b');
      expect(getQueue(next, 'c1').map(m => m.id)).toEqual(['a', 'c']);
    });

    it('drops the key when the last message is removed', () => {
      const q = enqueue({}, 'c1', msg('a'));
      const next = removeQueued(q, 'c1', 'a');
      expect('c1' in next).toBe(false);
    });

    it('returns the same reference when the id is not present', () => {
      const q = enqueue({}, 'c1', msg('a'));
      expect(removeQueued(q, 'c1', 'zzz')).toBe(q);
    });
  });

  describe('nodeOverride capture', () => {
    it('preserves the one-shot node pick captured at enqueue time', () => {
      let q: QueueMap = {};
      q = enqueue(q, 'c1', msg('a', 'a', 'node-1'));
      q = enqueue(q, 'c1', msg('b', 'b', null));
      const first = dequeue(q, 'c1');
      expect(first.head?.nodeOverride).toBe('node-1');
      const second = dequeue(first.queues, 'c1');
      expect(second.head?.nodeOverride).toBeNull();
    });
  });

  describe('canDrain', () => {
    const idle = { running: false, pendingApproval: false, debugPaused: false, hasError: false, stopped: false };

    it('drains when the conversation is idle and unblocked', () => {
      expect(canDrain(idle)).toBe(true);
    });

    it('holds while a run is in flight', () => {
      expect(canDrain({ ...idle, running: true })).toBe(false);
    });

    it('holds while awaiting tool approval', () => {
      expect(canDrain({ ...idle, pendingApproval: true })).toBe(false);
    });

    it('holds while paused in the debugger', () => {
      expect(canDrain({ ...idle, debugPaused: true })).toBe(false);
    });

    it('halts after an errored run', () => {
      expect(canDrain({ ...idle, hasError: true })).toBe(false);
    });

    it('halts after the user stopped the conversation', () => {
      expect(canDrain({ ...idle, stopped: true })).toBe(false);
    });
  });

  describe('FIFO drain simulation', () => {
    it('drains multiple queued messages one at a time in order', () => {
      let q: QueueMap = {};
      q = enqueue(q, 'c1', msg('a'));
      q = enqueue(q, 'c1', msg('b'));
      q = enqueue(q, 'c1', msg('c'));

      const sent: string[] = [];
      // Simulate: only drain when idle; each drain sends exactly one head.
      let running = false;
      while (peekQueue(q, 'c1') && canDrain({ running, pendingApproval: false, debugPaused: false, hasError: false, stopped: false })) {
        const { queues, head } = dequeue(q, 'c1');
        q = queues;
        sent.push(head!.id);
        // (a real run would flip running true then back false on run:done)
        running = false;
      }
      expect(sent).toEqual(['a', 'b', 'c']);
      expect(getQueue(q, 'c1')).toEqual([]);
    });
  });
});
