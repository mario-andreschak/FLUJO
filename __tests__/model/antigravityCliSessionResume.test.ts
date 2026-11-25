import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { AntigravityCliEvent } from '@/backend/services/model/adapters/antigravityCliEvents';

let mockDataDir = '';
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => mockDataDir, getCurrentWorkspace: () => 'test' }));
const mockRun = jest.fn();
jest.mock('@/backend/services/model/adapters/antigravityCliProcess', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/antigravityCliProcess'),
  runAntigravityCli: (...args: unknown[]) => mockRun(...args),
}));
const mockPrepare = jest.fn(async (options: { sessionHome?: string }) => ({ home: options.sessionHome ?? 'one-off', workingDirectory: 'neutral', env: {}, cleanup: async () => {} }));
jest.mock('@/backend/services/model/adapters/antigravityCliRuntime', () => ({ ANTIGRAVITY_CLI_TIMEOUT_MS: 300000, prepareAntigravityCliRuntime: (options: { sessionHome?: string }) => mockPrepare(options) }));
jest.mock('@/backend/services/model/adapters/codexToolBridge', () => ({ startCodexToolBridge: jest.fn(async () => ({ url: 'http://127.0.0.1/mcp/private', close: async () => {} })) }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { callTool: jest.fn() } }));
jest.mock('@/backend/mcpApps/toolUi', () => ({ resolveInvokedToolUiLink: async () => undefined, toolCancellationReason: () => undefined }));
jest.mock('@/backend/services/statistics', () => ({ classifyStatisticsError: () => 'tool', createStatisticsEvent: (event: unknown) => event, recordStatisticsEvent: () => {} }));

import { AntigravityCliAdapter } from '@/backend/services/model/adapters/antigravityCliAdapter';
import { AntigravityResumeMissError } from '@/backend/services/model/adapters/antigravityCliProcess';
import { openAntigravitySession, _resetAntigravitySweepForTests } from '@/backend/services/model/adapters/antigravityCliSession';

type RunOptions = { onEvent(event: AntigravityCliEvent): void; onStarted?(): Promise<void>; prompt: string; resumeConversationId?: string };
type Message = OpenAI.ChatCompletionMessageParam;

// Counters recorded from the official CLI 1.4.8 against a local fake model:
// a reopened conversation reports totals for the whole conversation.
const recorded = [
  { conversation: 'a4789f0f-5d90-42ad-9d89-1b5b47afb8ac', usage: { input_tokens: 200, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 205 }, turns: 1 },
  { conversation: 'a4789f0f-5d90-42ad-9d89-1b5b47afb8ac', usage: { input_tokens: 500, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 510 }, turns: 2 },
];
let fresh = 0;
function nativeTurn(reply: string, step = 0) {
  return async (options: RunOptions) => {
    await options.onStarted?.();
    const conversation = options.resumeConversationId ?? (fresh++ ? `fresh-${fresh}` : recorded[0].conversation);
    const { usage, turns } = options.resumeConversationId ? recorded[1] : recorded[0];
    options.onEvent({ event: 'init', conversation_id: conversation, init: { cwd: 'neutral', tools: [], permission_mode: 'request-review', agent: 'flujo' } });
    options.onEvent({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step, state: 'DONE', step_type: 'agent_response', text_delta: reply } });
    options.onEvent({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: reply, num_turns: turns, usage } });
  };
}

const system: Message = { role: 'system', content: 'Be brief.' };
const input = (messages: Message[], overrides: Partial<CompletionInput> = {}): CompletionInput => ({
  model: { id: 'antigravity', name: 'gemini-3.1-pro-high', ApiKey: 'key', provider: 'antigravity-cli', adapter: 'antigravity-cli' },
  apiKey: 'key', messages, conversationId: 'conversation-1', nodeId: 'node-1', sessionResume: true, ...overrides,
});
const firstTurn: Message[] = [system, { role: 'user', content: 'Remember the word apple.' }];
async function completeFirstTurn(overrides: Partial<CompletionInput> = {}): Promise<Message[]> {
  mockRun.mockImplementationOnce(nativeTurn('Noted.'));
  const first = await new AntigravityCliAdapter().createCompletion(input(firstTurn, overrides));
  return [...firstTurn, ...(first.transcript as Message[]), { role: 'user', content: 'Which word?' }];
}

beforeEach(async () => {
  mockDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-antigravity-resume-test-'));
  mockRun.mockReset(); mockPrepare.mockClear(); fresh = 0;
});
afterEach(async () => {
  await _resetAntigravitySweepForTests();
  await fs.rm(mockDataDir, { recursive: true, force: true });
});

test('the next turn reopens the saved conversation, sends only the new message and counts only its own usage', async () => {
  const secondTurn = await completeFirstTurn();
  expect(mockRun.mock.calls[0][0].resumeConversationId).toBeUndefined();
  expect(mockRun.mock.calls[0][0].prompt).toContain('Remember the word apple.');
  jest.resetModules();
  const { AntigravityCliAdapter: Restarted } = jest.requireActual<typeof import('@/backend/services/model/adapters/antigravityCliAdapter')>('@/backend/services/model/adapters/antigravityCliAdapter');
  mockRun.mockImplementationOnce(nativeTurn('apple', 4));
  const second = await new Restarted().createCompletion(input(secondTurn));
  const options = mockRun.mock.calls[1][0] as RunOptions;
  expect(options.resumeConversationId).toBe(recorded[0].conversation);
  expect(options.prompt).toContain('Which word?');
  expect(options.prompt).not.toContain('Remember the word apple.');
  expect(options.prompt).not.toContain('Be brief.');
  expect(mockPrepare.mock.calls[1][0].sessionHome).toBe(mockPrepare.mock.calls[0][0].sessionHome);
  expect(second.completion.choices[0].message.content).toBe('apple');
  expect(second.completion.usage).toMatchObject({ prompt_tokens: 300, completion_tokens: 5, total_tokens: 305 });
  expect(second.completion).toMatchObject({ flujo_antigravity_usage: { reported: [{ input_tokens: 300, output_tokens: 5, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 305 }], complete: true } });
});

test('a missed reopen replays the full conversation in the same call and saves the new conversation', async () => {
  const secondTurn = await completeFirstTurn();
  mockRun.mockImplementationOnce(async () => { throw new AntigravityResumeMissError(); }).mockImplementationOnce(nativeTurn('apple'));
  const second = await new AntigravityCliAdapter().createCompletion(input(secondTurn));
  expect(second.completion.choices[0].message.content).toBe('apple');
  expect(mockRun).toHaveBeenCalledTimes(3);
  expect(mockRun.mock.calls[2][0].resumeConversationId).toBeUndefined();
  expect(mockRun.mock.calls[2][0].prompt).toContain('Remember the word apple.');
  expect(second.completion.usage).toMatchObject({ prompt_tokens: 200, completion_tokens: 5 });
  mockRun.mockImplementationOnce(nativeTurn('again'));
  await new AntigravityCliAdapter().createCompletion(input([...secondTurn, ...(second.transcript as Message[]), { role: 'user', content: 'Once more.' }]));
  expect(mockRun.mock.calls[3][0].resumeConversationId).toBe('fresh-2');
});

test.each([
  ['the setting is off', { sessionResume: false }, false],
  ['the instructions changed', { messages: true }, true],
  ['the key changed', { apiKey: 'other-key' }, true],
])('%s: the full conversation is replayed', async (_name, change, keepsHome) => {
  const secondTurn = await completeFirstTurn();
  const messages = 'messages' in change ? [{ role: 'system', content: 'Be detailed.' } as Message, ...secondTurn.slice(1)] : secondTurn;
  mockRun.mockImplementationOnce(nativeTurn('apple'));
  await new AntigravityCliAdapter().createCompletion(input(messages, 'messages' in change ? {} : change as Partial<CompletionInput>));
  expect(mockRun.mock.calls[1][0].resumeConversationId).toBeUndefined();
  expect(mockRun.mock.calls[1][0].prompt).toContain('Remember the word apple.');
  expect(Boolean(mockPrepare.mock.calls[1][0].sessionHome)).toBe(keepsHome);
});

test('a failed turn forgets the checkpoint, so the next turn starts fresh', async () => {
  const secondTurn = await completeFirstTurn();
  mockRun.mockImplementationOnce(async () => { throw new Error('provider failed'); });
  await expect(new AntigravityCliAdapter().createCompletion(input(secondTurn))).rejects.toThrow('provider failed');
  mockRun.mockImplementationOnce(nativeTurn('apple'));
  await new AntigravityCliAdapter().createCompletion(input(secondTurn));
  expect(mockRun.mock.calls[2][0].resumeConversationId).toBeUndefined();
});

test('a conversation node already in use runs in a one-off home with the full conversation', async () => {
  const secondTurn = await completeFirstTurn();
  const held = await openAntigravitySession('conversation-1', 'node-1');
  try {
    mockRun.mockImplementationOnce(nativeTurn('apple'));
    await new AntigravityCliAdapter().createCompletion(input(secondTurn));
    expect(mockPrepare.mock.calls[1][0].sessionHome).toBeUndefined();
    expect(mockRun.mock.calls[1][0].resumeConversationId).toBeUndefined();
  } finally { await held?.release(); }
  mockRun.mockImplementationOnce(nativeTurn('apple'));
  await new AntigravityCliAdapter().createCompletion(input(secondTurn));
  expect(mockRun.mock.calls[2][0].resumeConversationId).toBe(recorded[0].conversation);
});
