import {
  sessionKey,
  computePrefixHash,
  findReusableSession,
  recordSession,
  invalidateSession,
  sessionCount,
  _clearAllSessionsForTests,
} from '@/backend/services/model/adapters/claudeSessionStore';

// Unit tests for the #154 Claude Agent SDK session registry: keying, prefix
// hashing (invalidation trigger) and the reuse/invalidation decision logic.
describe('claudeSessionStore (#154)', () => {
  beforeEach(() => {
    _clearAllSessionsForTests();
  });

  describe('sessionKey', () => {
    it('combines conversation and node id into a stable key', () => {
      expect(sessionKey('conv-1', 'node-a')).toBe('conv-1::node-a');
    });

    it('distinguishes different nodes of the same conversation', () => {
      expect(sessionKey('conv-1', 'node-a')).not.toBe(sessionKey('conv-1', 'node-b'));
    });
  });

  describe('computePrefixHash', () => {
    it('is stable for the same system prompt + tool set', () => {
      const a = computePrefixHash('you are helpful', ['toolA', 'toolB']);
      const b = computePrefixHash('you are helpful', ['toolA', 'toolB']);
      expect(a).toBe(b);
    });

    it('is order-independent across tool names', () => {
      const a = computePrefixHash('sys', ['toolA', 'toolB', 'toolC']);
      const b = computePrefixHash('sys', ['toolC', 'toolA', 'toolB']);
      expect(a).toBe(b);
    });

    it('changes when the system prompt changes', () => {
      const a = computePrefixHash('prompt one', ['t']);
      const b = computePrefixHash('prompt two', ['t']);
      expect(a).not.toBe(b);
    });

    it('changes when the tool set changes', () => {
      const a = computePrefixHash('sys', ['t1']);
      const b = computePrefixHash('sys', ['t1', 't2']);
      expect(a).not.toBe(b);
    });

    it('treats undefined and empty system prompt distinctly from real content', () => {
      const none = computePrefixHash(undefined, []);
      const empty = computePrefixHash('', []);
      const some = computePrefixHash('x', []);
      // undefined and '' collapse to the same empty prefix; real content differs.
      expect(none).toBe(empty);
      expect(some).not.toBe(none);
    });
  });

  describe('record / find / invalidate', () => {
    const key = sessionKey('conv', 'node');
    const prefixHash = computePrefixHash('sys', ['t']);

    it('returns undefined when nothing is recorded', () => {
      expect(findReusableSession(key, prefixHash, 5)).toBeUndefined();
    });

    it('returns the session when prefix matches and history has not shrunk', () => {
      recordSession(key, { sessionId: 'sid-1', prefixHash, seenMessageCount: 3 });
      const found = findReusableSession(key, prefixHash, 4);
      expect(found?.sessionId).toBe('sid-1');
      expect(found?.seenMessageCount).toBe(3);
    });

    it('allows reuse when the message count is unchanged (equal to seen)', () => {
      recordSession(key, { sessionId: 'sid-1', prefixHash, seenMessageCount: 3 });
      expect(findReusableSession(key, prefixHash, 3)?.sessionId).toBe('sid-1');
    });

    it('refuses reuse when the prefix hash changed (prompt/tools changed)', () => {
      recordSession(key, { sessionId: 'sid-1', prefixHash, seenMessageCount: 3 });
      const otherHash = computePrefixHash('sys', ['t', 'extra']);
      expect(findReusableSession(key, otherHash, 4)).toBeUndefined();
    });

    it('refuses reuse when the conversation shrank (client-side pruning/divergence)', () => {
      recordSession(key, { sessionId: 'sid-1', prefixHash, seenMessageCount: 10 });
      expect(findReusableSession(key, prefixHash, 4)).toBeUndefined();
    });

    it('overwrites the entry in place on re-record', () => {
      recordSession(key, { sessionId: 'sid-1', prefixHash, seenMessageCount: 3 });
      recordSession(key, { sessionId: 'sid-2', prefixHash, seenMessageCount: 5 });
      expect(sessionCount()).toBe(1);
      expect(findReusableSession(key, prefixHash, 5)?.sessionId).toBe('sid-2');
    });

    it('invalidate drops the session so it can no longer be reused', () => {
      recordSession(key, { sessionId: 'sid-1', prefixHash, seenMessageCount: 3 });
      invalidateSession(key);
      expect(findReusableSession(key, prefixHash, 4)).toBeUndefined();
      expect(sessionCount()).toBe(0);
    });

    it('invalidate is a no-op for an unknown key', () => {
      expect(() => invalidateSession('missing::key')).not.toThrow();
      expect(sessionCount()).toBe(0);
    });

    it('keeps sessions for different (conversation,node) keys independent', () => {
      const keyA = sessionKey('conv', 'node-a');
      const keyB = sessionKey('conv', 'node-b');
      recordSession(keyA, { sessionId: 'a', prefixHash, seenMessageCount: 1 });
      recordSession(keyB, { sessionId: 'b', prefixHash, seenMessageCount: 1 });
      invalidateSession(keyA);
      expect(findReusableSession(keyA, prefixHash, 1)).toBeUndefined();
      expect(findReusableSession(keyB, prefixHash, 1)?.sessionId).toBe('b');
    });
  });
});
