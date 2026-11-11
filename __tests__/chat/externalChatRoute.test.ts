import { NextRequest } from 'next/server';

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: <T,>(handler: T) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));
jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({
  processChatCompletion: jest.fn(async () => new Response('{}')),
}));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: jest.fn(async () => undefined),
}));
jest.mock('@/app/v1/chat/completions/externalChatContinuity', () => ({
  ...jest.requireActual('@/app/v1/chat/completions/externalChatContinuity'),
  beginExternalChatTurn: jest.fn(),
}));

import { POST } from '@/app/v1/chat/completions/route';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { beginExternalChatTurn } from '@/app/v1/chat/completions/externalChatContinuity';

const url = 'http://localhost/v1/chat/completions';
const history = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
  { role: 'user', content: 'next' },
];
const send = (body: unknown) => POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));
const turn = (extra: Record<string, unknown>) => ({
  messages: history,
  remember: jest.fn(async () => undefined),
  release: jest.fn(async () => undefined),
  ...extra,
});

beforeEach(() => jest.clearAllMocks());

it('sends a recognized chat to its conversation with only the new message', async () => {
  const continued = turn({ conversationId: 'conversation-a', messages: [history[2]] });
  jest.mocked(beginExternalChatTurn).mockResolvedValue(continued as never);

  await send({ model: 'flow-Test', messages: history });

  expect(processChatCompletion).toHaveBeenCalledWith(
    expect.objectContaining({ messages: [history[2]], appendMessages: true }),
    false, false, false, 'conversation-a', false, true, undefined, expect.anything(), continued,
  );
  expect(continued.release).not.toHaveBeenCalled();
});

it('runs an unrecognized chat from its full history as a new conversation', async () => {
  const fresh = turn({});
  jest.mocked(beginExternalChatTurn).mockResolvedValue(fresh as never);

  await send({ model: 'flow-Test', messages: history });

  const [data, , , , conversationId] = jest.mocked(processChatCompletion).mock.calls[0];
  expect(data.messages).toEqual(history);
  expect(data.appendMessages).toBeFalsy();
  expect(conversationId).toBeUndefined();
});

it('gives the conversation back when the request is refused', async () => {
  const continued = turn({ conversationId: 'conversation-a' });
  jest.mocked(beginExternalChatTurn).mockResolvedValue(continued as never);
  jest.mocked(processChatCompletion).mockResolvedValueOnce(new Response('{}', { status: 503 }));

  const response = await send({ model: 'flow-Test', messages: history });

  expect(response.status).toBe(503);
  expect(continued.release).toHaveBeenCalledTimes(1);
});

it('gives the conversation back when processing throws', async () => {
  const continued = turn({ conversationId: 'conversation-a' });
  jest.mocked(beginExternalChatTurn).mockResolvedValue(continued as never);
  jest.mocked(processChatCompletion).mockRejectedValueOnce(new Error('fixture failure'));

  const response = await send({ model: 'flow-Test', messages: history });

  expect(response.status).toBe(500);
  expect(continued.release).toHaveBeenCalledTimes(1);
});

it.each([
  ['names its conversation', { model: 'flow-Test', messages: history, metadata: { conversationId: 'chosen' } }],
  ['comes from FLUJO itself', { model: 'flow-Test', messages: history, metadata: { flujo: 'true' } }],
  ['is a direct model call', { model: 'model-test', messages: history }],
])('does not look up a request that %s', async (_label, body) => {
  await send(body);
  expect(beginExternalChatTurn).not.toHaveBeenCalled();
  expect(processChatCompletion).toHaveBeenCalledTimes(1);
});
