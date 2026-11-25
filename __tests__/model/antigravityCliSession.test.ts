import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import type OpenAI from 'openai';

let mockDataDir = '';
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => mockDataDir, getCurrentWorkspace: () => 'test' }));
import {
  ANTIGRAVITY_SESSION_TTL_MS, antigravityHistoryHash, antigravitySessionPrefix, antigravitySessionsRoot, antigravityRuntimeRoot,
  findAntigravityResume, openAntigravitySession, sweepAntigravityRuntime, _resetAntigravitySweepForTests,
} from '@/backend/services/model/adapters/antigravityCliSession';

type Message = OpenAI.ChatCompletionMessageParam;
let temporary: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-antigravity-session-test-'));
  mockDataDir = path.join(temporary, 'data');
});
afterEach(async () => {
  await _resetAntigravitySweepForTests();
  await fs.rm(temporary, { recursive: true, force: true });
});

const first: Message[] = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Remember apple.' }];
const answer: Message[] = [{ role: 'assistant', content: 'Noted.' }];
const prefix = antigravitySessionPrefix({ systemPrompt: 'Be brief.', model: 'gemini', tools: [] });
const checkpoint = (usage = { input_tokens: 200, output_tokens: 5, cache_read_tokens: 0, num_turns: 1 }) => ({
  conversationId: 'a4789f0f-5d90-42ad-9d89-1b5b47afb8ac', prefixHash: prefix, seenMessageCount: 3, leadingSystemMessageCount: 1,
  historyHash: antigravityHistoryHash([...first, ...answer], 1), usage,
});

test('a saved conversation survives a restart and resumes with only the new messages', async () => {
  const opened = await openAntigravitySession('conversation-1', 'node-1');
  expect(opened?.record).toBeUndefined();
  await opened!.save(checkpoint());
  await opened!.release();
  jest.resetModules();
  const reloaded = jest.requireActual<typeof import('@/backend/services/model/adapters/antigravityCliSession')>('@/backend/services/model/adapters/antigravityCliSession');
  const again = await reloaded.openAntigravitySession('conversation-1', 'node-1');
  expect(again!.home).toBe(opened!.home);
  const next: Message = { role: 'user', content: 'Which fruit?' };
  // Ids and timestamps added by the caller do not change the consumed history.
  const stored: Message[] = [...first, Object.assign({}, answer[0], { id: 'm_1', timestamp: 5 }), next];
  expect(reloaded.findAntigravityResume(again!.record, { prefixHash: prefix, messages: stored, leadingSystemMessageCount: 1 })).toEqual({
    conversationId: checkpoint().conversationId, delta: [next], baseline: checkpoint().usage,
  });
  await again!.release();
});

const edited: Message[] = [first[0], { role: 'user', content: 'Remember pear.' }, ...answer, { role: 'user', content: 'Which fruit?' }];
test.each<[string, { prefixHash?: string; messages?: Message[]; leadingSystemMessageCount?: number; now?: number }]>([
  ['changed instructions or tools', { prefixHash: 'other' }],
  ['an edited earlier message', { messages: edited }],
  ['a shortened history', { messages: [...first, ...answer] }],
  ['another leading system message', { leadingSystemMessageCount: 2 }],
  ['an idle day', { now: Date.now() + 2 * ANTIGRAVITY_SESSION_TTL_MS }],
])('%s replays the full conversation', (_name, change) => {
  const record = { ...checkpoint(), version: 1 as const, updatedAt: Date.now() };
  const current = { prefixHash: prefix, messages: [...first, ...answer, { role: 'user', content: 'Which fruit?' }] as Message[], leadingSystemMessageCount: 1, ...change };
  expect(findAntigravityResume(record, current)).toBeUndefined();
});

test('one run holds a session at a time; others fall back, and a crashed holder heals', async () => {
  const held = await openAntigravitySession('conversation-1', 'node-1');
  expect(held).toBeDefined();
  expect(await openAntigravitySession('conversation-1', 'node-1')).toBeUndefined();
  expect(await openAntigravitySession('conversation-1', 'node-2')).toBeDefined();
  await held!.release();
  const reopened = await openAntigravitySession('conversation-1', 'node-1');
  expect(reopened).toBeDefined();
  await reopened!.release();
  const lock = path.join(antigravitySessionsRoot(), `${path.basename(reopened!.home)}.lock`);
  await fs.writeFile(lock, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  expect(await openAntigravitySession('conversation-1', 'node-1')).toBeUndefined();
  await fs.writeFile(lock, JSON.stringify({ pid: 2 ** 30, at: Date.now() }));
  const healed = await openAntigravitySession('conversation-1', 'node-1');
  expect(healed).toBeDefined();
  await healed!.release();
});

test('reset empties the native conversation store, and unreadable checkpoints start fresh', async () => {
  const opened = await openAntigravitySession('conversation-1', 'node-1');
  await fs.mkdir(path.join(opened!.home, '.gemini', 'antigravity-cli', 'brain', 'old'), { recursive: true });
  await opened!.reset();
  expect(await fs.readdir(opened!.home)).toEqual([]);
  await fs.writeFile(path.join(antigravitySessionsRoot(), `${path.basename(opened!.home)}.json`), '{"version":1,"conversationId":"--bad"}');
  await opened!.release();
  expect((await openAntigravitySession('conversation-1', 'node-1'))?.record).toBeUndefined();
});

test('cleanup removes idle sessions and crashed one-off homes, and keeps active ones', async () => {
  const idle = await openAntigravitySession('conversation-1', 'idle');
  await idle!.save(checkpoint()); await fs.mkdir(idle!.home, { recursive: true }); await idle!.release();
  const active = await openAntigravitySession('conversation-1', 'active');
  await active!.save(checkpoint()); await fs.mkdir(active!.home, { recursive: true });
  const crashed = path.join(antigravityRuntimeRoot(), 'invocation-crashed');
  await fs.mkdir(path.join(crashed, '.gemini'), { recursive: true });
  const later = Date.now() + ANTIGRAVITY_SESSION_TTL_MS + 60_000;
  await sweepAntigravityRuntime(later);
  await expect(fs.access(idle!.home)).rejects.toThrow();
  await expect(fs.access(path.join(antigravitySessionsRoot(), `${path.basename(idle!.home)}.json`))).rejects.toThrow();
  await expect(fs.access(active!.home)).resolves.toBeUndefined();
  await expect(fs.access(crashed)).rejects.toThrow();
  await active!.release();
  const recent = path.join(antigravityRuntimeRoot(), 'invocation-running');
  await fs.mkdir(recent);
  await sweepAntigravityRuntime();
  await expect(fs.access(recent)).resolves.toBeUndefined();
  await expect(fs.access(active!.home)).resolves.toBeUndefined();
});
