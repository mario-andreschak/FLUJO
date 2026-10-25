import { NextRequest } from 'next/server';
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: <T,>(handler: T) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({ processChatCompletion: jest.fn(async () => new Response('{}')) }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: jest.fn() }));
import { POST, GET } from '@/app/v1/chat/completions/route';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { acquireChatIngress, CHAT_INGRESS_LIMITS, getChatIngressDiagnostics } from '@/utils/http/chatIngress';
const url = 'http://localhost/v1/chat/completions';
beforeEach(() => jest.clearAllMocks());
afterEach(() => expect(getChatIngressDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 }));

it.each(['running', 'paused_debug', 'awaiting_tool_approval', 'error'])('does not touch a protected %s owner or provider on refused input', async status => {
  const existing = { status, messages: [{ role: 'user', content: 'preserve me' }], recovery: { effect: 'unknown' } };
  const original = structuredClone(existing);
  jest.mocked(loadConversationState).mockResolvedValue(existing as never);
  const request = new NextRequest(url, { method: 'POST', body: '{}', headers: { 'content-length': String(CHAT_INGRESS_LIMITS.bodyBytes + 1) } });
  const response = await POST(request);
  expect(response.status).toBe(413);
  await expect(response.json()).resolves.toMatchObject({ error: { code: 'CHAT_INPUT_TOO_LARGE', type: 'invalid_request_error', param: null } });
  expect(processChatCompletion).not.toHaveBeenCalled(); expect(loadConversationState).not.toHaveBeenCalled();
  expect(existing).toEqual(original);
});

it('returns actionable busy errors before parsed input or service invocation', async () => {
  const owners = [acquireChatIngress(new NextRequest(url)), acquireChatIngress(new NextRequest(url))];
  try {
    const response = await POST(new NextRequest(url, { method: 'POST', body: '{}' }));
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('5');
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'CHAT_INPUT_BUSY', type: 'rate_limit_error' } });
    expect(processChatCompletion).not.toHaveBeenCalled();
  } finally { owners.forEach(owner => owner.release()); }
});

it('returns malformed JSON as a private-data-free 400', async () => {
  const response = await POST(new NextRequest(url, { method: 'POST', body: '{"private-source": nope}' }));
  expect(response.status).toBe(400);
  const body = await response.text(); expect(body).toContain('CHAT_INPUT_INVALID'); expect(body).not.toContain('private-source');
  expect(processChatCompletion).not.toHaveBeenCalled();
});

it('enforces GET limits and releases admission after a successful response', async () => {
  const refused = await GET(new NextRequest(`${url}?${'x=1&'.repeat(129)}`));
  expect(refused.status).toBe(413); expect(processChatCompletion).not.toHaveBeenCalled();
  const allowed = await GET(new NextRequest(`${url}?model=model-test&message=hello`));
  expect(allowed.status).toBe(200); expect(processChatCompletion).toHaveBeenCalledTimes(1);
});

it('releases admission on service errors and response-header construction failure', async () => {
  const body = JSON.stringify({ model: 'model-test', messages: [] });
  jest.mocked(processChatCompletion).mockRejectedValueOnce(new Error('fixture failure'));
  expect((await POST(new NextRequest(url, { method: 'POST', body }))).status).toBe(500);
  jest.mocked(processChatCompletion).mockResolvedValueOnce({ body: null, status: 999, headers: new Headers() } as never);
  expect((await POST(new NextRequest(url, { method: 'POST', body }))).status).toBe(500);
});
