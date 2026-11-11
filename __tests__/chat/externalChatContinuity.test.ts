/**
 * Issue #1395: chat apps resend the whole history with no conversation id, and
 * each message used to become a new FLUJO conversation.
 */
const mockLinks = new Map<string, unknown>();
const mockStates = new Map<string, Record<string, unknown>>();

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }),
}));
jest.mock('@/utils/storage/backend', () => ({
  saveCollectionItem: jest.fn(async (_collection: string, id: string, value: unknown) => { mockLinks.set(id, value); }),
  loadCollectionItem: jest.fn(async (_collection: string, id: string, fallback: unknown) => mockLinks.get(id) ?? fallback),
  deleteCollectionItem: jest.fn(async (_collection: string, id: string) => { mockLinks.delete(id); }),
}));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: jest.fn(async (id: string) => mockStates.get(id)),
}));
jest.mock('@/backend/services/workspace/workerMode', () => ({ isWorkerMode: jest.fn(() => false) }));

import { beginExternalChatTurn, isExternalChatRequest } from '@/app/v1/chat/completions/externalChatContinuity';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import type OpenAI from 'openai';

type Message = OpenAI.ChatCompletionMessageParam;
const model = 'flow-Test';
const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });
const system = (content: string): Message => ({ role: 'system', content });

async function finishFirstTurn(id: string, question: string, reply: string, extra: Record<string, unknown> = {}) {
  const turn = await beginExternalChatTurn({ model, messages: [user(question)] });
  mockStates.set(id, { status: 'completed', messages: [{ id: 'last' }], ...extra });
  await turn.remember(reply, id, 'last');
  return turn;
}

beforeEach(() => {
  mockLinks.clear();
  mockStates.clear();
  jest.mocked(isWorkerMode).mockReturnValue(false);
});

describe('continuing a chat from an outside app', () => {
  it('starts a new conversation for the first message', async () => {
    const turn = await beginExternalChatTurn({ model, messages: [user('hello')] });
    expect(turn.conversationId).toBeUndefined();
    expect(turn.messages).toEqual([user('hello')]);
  });

  it('joins the same conversation and runs only the new message', async () => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there');
    const turn = await beginExternalChatTurn({
      model,
      messages: [user('hello'), assistant('hi there'), user('and now?')],
    });
    expect(turn.conversationId).toBe('conversation-a');
    expect(turn.messages).toEqual([user('and now?')]);
  });

  it('keeps following the chat across several turns', async () => {
    await finishFirstTurn('conversation-a', 'one', 'reply one');
    const history = [user('one'), assistant('reply one'), user('two')];
    const second = await beginExternalChatTurn({ model, messages: history });
    expect(second.conversationId).toBe('conversation-a');
    mockStates.set('conversation-a', { status: 'completed', messages: [{ id: 'later' }] });
    await second.remember('reply two', 'conversation-a', 'later');

    const third = await beginExternalChatTurn({
      model,
      messages: [...history, assistant('reply two'), user('three')],
    });
    expect(third.conversationId).toBe('conversation-a');
    expect(third.messages).toEqual([user('three')]);
  });

  it('still matches when the app trims the reply or rebuilds the system prompt', async () => {
    await finishFirstTurn('conversation-a', 'hello', '  hi\n\nthere  ');
    const turn = await beginExternalChatTurn({
      model,
      messages: [system('Today is Tuesday'), user('hello'), assistant('hi there'), user('next')],
    });
    expect(turn.conversationId).toBe('conversation-a');
  });

  it('still matches when the app folds reasoning away before resending', async () => {
    await finishFirstTurn('conversation-a', 'hello', '<think>let me see</think>hi there');
    const turn = await beginExternalChatTurn({
      model,
      messages: [user('hello'), assistant('hi there'), user('next')],
    });
    expect(turn.conversationId).toBe('conversation-a');
  });

  it('handles messages made of several parts', async () => {
    const question: Message = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
    const first = await beginExternalChatTurn({ model, messages: [question] });
    mockStates.set('conversation-a', { status: 'completed', messages: [{ id: 'last' }] });
    await first.remember('hi', 'conversation-a', 'last');
    const turn = await beginExternalChatTurn({ model, messages: [question, assistant('hi'), user('next')] });
    expect(turn.conversationId).toBe('conversation-a');
  });

  it.each([
    ['a different reply', [user('hello'), assistant('something else'), user('next')], model],
    ['a different question', [user('other'), assistant('hi there'), user('next')], model],
    ['a different flow', [user('hello'), assistant('hi there'), user('next')], 'flow-Other'],
  ])('does not join a conversation with %s', async (_label, messages, requestModel) => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there');
    const turn = await beginExternalChatTurn({ model: requestModel as string, messages: messages as Message[] });
    expect(turn.conversationId).toBeUndefined();
    expect(turn.messages).toEqual(messages);
  });

  it('keeps different app users apart', async () => {
    const first = await beginExternalChatTurn({ model, user: 'alice', messages: [user('hello')] });
    mockStates.set('conversation-a', { status: 'completed', messages: [{ id: 'last' }] });
    await first.remember('hi', 'conversation-a', 'last');
    const turn = await beginExternalChatTurn({ model, user: 'bob', messages: [user('hello'), assistant('hi'), user('next')] });
    expect(turn.conversationId).toBeUndefined();
  });

  it('starts fresh instead of overwriting a conversation that moved on', async () => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there');
    mockStates.set('conversation-a', { status: 'completed', messages: [{ id: 'added-in-flujo' }] });
    const messages = [user('hello'), assistant('hi there'), user('next')];
    const turn = await beginExternalChatTurn({ model, messages });
    expect(turn.conversationId).toBeUndefined();
    expect(turn.messages).toEqual(messages);
  });

  it.each(['running', 'awaiting_tool_approval', 'paused_debug'])('does not interrupt a %s conversation', async status => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there', { status });
    const turn = await beginExternalChatTurn({ model, messages: [user('hello'), assistant('hi there'), user('next')] });
    expect(turn.conversationId).toBeUndefined();
  });

  it.each([
    ['owned by a Persona', { personaOwned: true }],
    ['targeted at a Persona', { personaTargetId: 'persona-1' }],
    ['held by a meeting', { meetingParticipant: { meetingId: 'meeting-1' } }],
  ])('does not join a conversation %s', async (_label, extra) => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there', extra);
    const turn = await beginExternalChatTurn({ model, messages: [user('hello'), assistant('hi there'), user('next')] });
    expect(turn.conversationId).toBeUndefined();
  });

  it('removes a link whose conversation was deleted', async () => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there');
    mockStates.delete('conversation-a');
    const turn = await beginExternalChatTurn({ model, messages: [user('hello'), assistant('hi there'), user('next')] });
    expect(turn.conversationId).toBeUndefined();
    expect(mockLinks.size).toBe(0);
  });

  it('lets only one of two simultaneous requests continue a conversation', async () => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there');
    const messages = [user('hello'), assistant('hi there'), user('next')];
    const turns = await Promise.all([
      beginExternalChatTurn({ model, messages }),
      beginExternalChatTurn({ model, messages }),
    ]);
    expect(turns.filter(turn => turn.conversationId === 'conversation-a')).toHaveLength(1);
  });

  it('gives the link back when the turn is refused before it changes anything', async () => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there');
    const messages = [user('hello'), assistant('hi there'), user('next')];
    const refused = await beginExternalChatTurn({ model, messages });
    await refused.release();
    const retry = await beginExternalChatTurn({ model, messages });
    expect(retry.conversationId).toBe('conversation-a');
  });

  it('does not give the link back once the turn has changed the conversation', async () => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there');
    const messages = [user('hello'), assistant('hi there'), user('next')];
    const failed = await beginExternalChatTurn({ model, messages });
    mockStates.set('conversation-a', { status: 'error', messages: [{ id: 'appended' }] });
    await failed.release();
    expect(mockLinks.size).toBe(0);
  });

  it('keeps the link when the conversation is only busy being read', async () => {
    await finishFirstTurn('conversation-a', 'hello', 'hi there');
    const pressure = Object.create(ConversationLogReadPressureError.prototype) as Error;
    jest.mocked(loadConversationState).mockRejectedValueOnce(pressure);
    const messages = [user('hello'), assistant('hi there'), user('next')];
    await expect(beginExternalChatTurn({ model, messages })).rejects.toBe(pressure);
    const retry = await beginExternalChatTurn({ model, messages });
    expect(retry.conversationId).toBe('conversation-a');
  });

  it('stores only hashes and ids, never the chat text', async () => {
    await finishFirstTurn('conversation-a', 'a private question', 'a private answer');
    expect(JSON.stringify([...mockLinks.entries()])).not.toContain('private');
  });

  it('skips recording an empty reply', async () => {
    const turn = await beginExternalChatTurn({ model, messages: [user('hello')] });
    await turn.remember('   ', 'conversation-a', 'last');
    expect(mockLinks.size).toBe(0);
  });
});

describe('which requests get this handling', () => {
  const base = { model, flujo: false, flujodebug: false };

  it('covers a plain request to a flow', () => {
    expect(isExternalChatRequest('POST', base)).toBe(true);
  });

  it.each([
    ['FLUJO\'s own chat', { flujo: true }],
    ['the debugger', { flujodebug: true }],
    ['a named conversation', { conversation_id: 'conversation-a' }],
    ['a Persona', { personaTarget: { personaId: 'p' } }],
    ['a message edit', { processNodeId: 'node' }],
    ['an append request', { appendMessages: true }],
    ['a direct model call', { model: 'model-test' }],
    ['a routing policy', { model: 'policy/fast' }],
  ])('leaves %s alone', (_label, extra) => {
    expect(isExternalChatRequest('POST', { ...base, ...extra })).toBe(false);
  });

  it('leaves GET requests and worker runs alone', () => {
    expect(isExternalChatRequest('GET', base)).toBe(false);
    jest.mocked(isWorkerMode).mockReturnValue(true);
    expect(isExternalChatRequest('POST', base)).toBe(false);
  });
});
