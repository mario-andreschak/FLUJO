/**
 * `metadata.requireApproval` on /v1/chat/completions (#1284, R1 and R2).
 *
 * The conversation's saved "Require tool approvals" setting is the one source a
 * run follows. A request that says nothing hands `undefined` to the run, which
 * then keeps the saved value (see __tests__/flow/toolApprovalDuringRun.test.ts);
 * "true" or "false" is a choice the run saves. Any other value is refused with a
 * message that says how to fix it, instead of being read as off.
 */
import { NextRequest } from 'next/server';
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: <T,>(handler: T) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/utils/logger', () => ({ createLogger: jest.fn(() => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })) }));
jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({ processChatCompletion: jest.fn(async () => new Response('{}')) }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: jest.fn() }));
import { POST, GET } from '@/app/v1/chat/completions/route';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { parseRequireApproval } from '@/app/v1/chat/completions/requestParser';

const url = 'http://localhost/v1/chat/completions';
const send = (metadata: Record<string, unknown>) => POST(new NextRequest(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'flow-Test', messages: [{ role: 'user', content: 'hi' }], metadata: { flujo: 'true', conversationId: 'conv-1', ...metadata } }),
}));
const requestedApproval = () => jest.mocked(processChatCompletion).mock.calls.at(-1)?.[2];

beforeEach(() => jest.clearAllMocks());

it.each([
  ['left out', {}, undefined],
  ['null', { requireApproval: null }, undefined],
  ['"true"', { requireApproval: 'true' }, true],
  ['"false"', { requireApproval: 'false' }, false],
  ['true', { requireApproval: true }, true],
  ['false', { requireApproval: false }, false],
])('hands the run the choice when it is %s', async (_label, metadata, expected) => {
  const response = await send(metadata);

  expect(response.status).toBe(200);
  expect(processChatCompletion).toHaveBeenCalledTimes(1);
  expect(requestedApproval()).toBe(expected);
});

it.each([['yes'], ['TRUE'], ['1'], [1]])('refuses %p instead of reading it as off', async (value) => {
  const response = await send({ requireApproval: value });

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: { type: 'invalid_request_error', code: 'invalid_require_approval', message: expect.stringContaining('"true" or "false"') },
  });
  expect(processChatCompletion).not.toHaveBeenCalled();
});

it('carries no choice on a GET, which starts a new conversation', async () => {
  expect((await GET(new NextRequest(`${url}?model=flow-Test&message=hello`))).status).toBe(200);
  expect(requestedApproval()).toBeUndefined();
});

it('reads only the two words and the two booleans', () => {
  expect([undefined, null, 'true', 'false', true, false].map(parseRequireApproval)).toEqual([undefined, undefined, true, false, true, false]);
  expect(() => parseRequireApproval('on')).toThrow('must be "true" or "false"');
});
