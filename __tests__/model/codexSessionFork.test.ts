import type { CodexSessionMetadata } from '@/backend/execution/flow/types';
import { computeCodexHistoryHash, findForkableCodexSession, findReusableCodexSession,
  requestCodexSessionFork } from '@/backend/services/model/adapters/codexSessionStore';

const history = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'discarded' }, { role: 'assistant', content: 'discarded answer' }];
const prefixHash = 'compatible-account-runtime-tools-instructions';
const session: CodexSessionMetadata = { adapter: 'codex-cli', provider: 'codex', threadId: 'parent-thread',
  nativeSessionId: 'parent-thread', configurationHash: prefixHash, prefixHash,
  seenMessageCount: 4, historyHash: computeCodexHistoryHash(history), updatedAt: 1,
  totalUsage: { input_tokens: 200, output_tokens: 40 }, checkpoints: [
    { turnId: 'turn-1', seenMessageCount: 2, historyHash: computeCodexHistoryHash(history.slice(0, 2)),
      totalUsage: { input_tokens: 100, output_tokens: 20 } },
    { turnId: 'turn-2', seenMessageCount: 4, historyHash: computeCodexHistoryHash(history),
      totalUsage: { input_tokens: 200, output_tokens: 40 } },
  ] };
const branch = [...history.slice(0, 2), { role: 'user', content: 'replacement' }];

it('selects the last completed checkpoint matching the retained canonical prefix, excluding later turns', () => {
  expect(findReusableCodexSession('node', prefixHash, branch, session)).toBeUndefined();
  expect(findForkableCodexSession('node', prefixHash, branch, JSON.parse(JSON.stringify(session)))?.checkpoint)
    .toEqual(session.checkpoints![0]);
});

it('never forks through account/runtime/tool/instruction drift or edited earlier history', () => {
  expect(findForkableCodexSession('node', 'changed-prefix', branch, session)).toBeUndefined();
  expect(findForkableCodexSession('node', prefixHash, [{ role: 'user', content: 'edited first' }, ...branch.slice(1)], session)).toBeUndefined();
});

it('continues compatible appended history without creating a branch', () => {
  const next = [...history, { role: 'user', content: 'next' }];
  expect(findReusableCodexSession('node', prefixHash, next, session)?.threadId).toBe('parent-thread');
  expect(findForkableCodexSession('node', prefixHash, next, session)).toBeUndefined();
  expect(findForkableCodexSession('node', prefixHash, history, session)).toBeUndefined();
});

it('marks only proven checkpoints for restoration, preserving the source metadata without mutation', () => {
  const old = { ...session, checkpoints: undefined };
  const restored = requestCodexSessionFork({ supported: session, legacy: old });
  expect(Object.keys(restored!)).toEqual(['supported']);
  expect(restored!.supported.forkRequired).toBe(true);
  expect(session.forkRequired).toBeUndefined();
  expect(findReusableCodexSession('node', prefixHash, [...history, { role: 'user', content: 'next' }], restored!.supported)).toBeUndefined();
  expect(requestCodexSessionFork({ legacy: old })).toBeUndefined();
});

it('does not treat malformed or unbounded persisted checkpoints as native fork authority', () => {
  expect(findForkableCodexSession('node', prefixHash, branch, { ...session, checkpoints: [{
    ...session.checkpoints![0], turnId: '../outside',
  }] })).toBeUndefined();
  expect(findForkableCodexSession('node', prefixHash, branch, { ...session,
    checkpoints: Array.from({ length: 33 }, () => session.checkpoints![0]),
  })).toBeUndefined();
});
