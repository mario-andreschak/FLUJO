import type OpenAI from 'openai';
import {
  computeCodexHistoryHash, computeCodexPrefixHash, findReusableCodexSession,
  type StoredCodexSession,
} from '@/backend/services/model/adapters/codexSessionStore';
import {
  _clearAllSessionsForTests, computePrefixHash, computeHistoryHash, findReusableSession, recordSession,
} from '@/backend/services/model/adapters/claudeSessionStore';

jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'projection-compatibility-test' }));
jest.mock('@/backend/services/model/adapters/codexAuth', () => ({
  readCodexAuthForTransfer: jest.fn(() => { throw new Error('Credential access is outside this regression.'); }),
}));

const instructions = 'Preserve original instructions';
const configuration = {
  adapter: 'codex-sdk', provider: 'openai', model: 'gpt-test', accountScope: 'account-A',
  runtimeIdentity: 'app-server-v1', developerInstructions: 'Use FLUJO tools',
};
// Prefix fixtures from faaf86c5, before projection-policy binding. No credentials.
const legacyCodexPrefix = '951bb2953b53650a8fe137c2496e677d80a881556b1a820a6ec6dcfdc367ab96';
const legacyClaudePrefix = '5d7ceec2b0ccbc1316f6c068263b01030d6c6d9487fb0064f0873880f1166663';
const previous: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'user', content: 'Read the exact observation.' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'exact-call-id', type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: 'x'.repeat(5000) }) } }] },
  { role: 'tool', tool_call_id: 'exact-call-id', content: 'a'.repeat(6000) + 'EXACT-TAIL' },
];
const appended: OpenAI.ChatCompletionMessageParam[] = [...previous, { role: 'user', content: 'Continue.' }];

beforeEach(() => _clearAllSessionsForTests());

it('refuses durable Codex sessions with a legacy projection, then reuses the corrected replacement', () => {
  const prefix = computeCodexPrefixHash(configuration, instructions, []);
  const stored: StoredCodexSession = {
    adapter: configuration.adapter, provider: configuration.provider, threadId: 'legacy-thread',
    configurationHash: computeCodexPrefixHash(configuration, undefined, []), prefixHash: legacyCodexPrefix,
    historyHash: computeCodexHistoryHash(previous), seenMessageCount: previous.length, updatedAt: 1,
  };
  // Raw history has not changed: a policy change alone must prevent delta-only resume.
  expect(findReusableCodexSession('conversation::node', prefix, appended, stored)).toBeUndefined();
  const replacement = { ...stored, threadId: 'corrected-thread', prefixHash: prefix };
  expect(findReusableCodexSession('conversation::node', prefix, appended, replacement)).toBe(replacement);
});

it('refuses Claude sessions with a legacy projection, then reuses the corrected replacement', () => {
  const prefix = computePrefixHash(instructions, []);
  const key = 'conversation::node';
  recordSession(key, { sessionId: 'legacy-session', prefixHash: legacyClaudePrefix,
    seenMessageCount: previous.length, leadingSystemMessageCount: 0,
    historyHash: computeHistoryHash(previous as Array<{ role: string; [key: string]: unknown }>) });
  expect(findReusableSession(key, prefix, appended as Array<{ role: string; [key: string]: unknown }>, 0)).toBeUndefined();
  recordSession(key, { sessionId: 'corrected-session', prefixHash: prefix,
    seenMessageCount: previous.length, leadingSystemMessageCount: 0,
    historyHash: computeHistoryHash(previous as Array<{ role: string; [key: string]: unknown }>) });
  expect(findReusableSession(key, prefix, appended as Array<{ role: string; [key: string]: unknown }>, 0)?.sessionId).toBe('corrected-session');
});
