import { NextRequest } from 'next/server';
import type { ChatIngressPermit } from '@/utils/http/chatIngress';
const wrapperHook = jest.fn<Promise<Response | undefined>, [NextRequest, ChatIngressPermit]>();
jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: (request: NextRequest, permit: ChatIngressPermit) => Promise<Response>) =>
    async (request: NextRequest, permit: ChatIngressPermit) => {
      const refused = await wrapperHook(request, permit);
      return refused ?? handler(request, permit);
    },
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({ processChatCompletion: jest.fn(async () => new Response('{}')) }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: jest.fn() }));
import { GET, POST, OPTIONS } from '@/app/v1/chat/completions/route';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { acquireChatIngress, CHAT_INGRESS_LIMITS, getChatIngressDiagnostics } from '@/utils/http/chatIngress';
const url = 'http://localhost/v1/chat/completions';
const methods = [{ method: 'GET', handler: GET }, { method: 'POST', handler: POST }, { method: 'OPTIONS', handler: OPTIONS }];

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(processChatCompletion).mockReset().mockImplementation(async () => new Response('{}'));
  wrapperHook.mockReset().mockImplementation(async request => {
    // This is the allocation performed by parseWorkspaceParam before the old
    // handler-level admission. Refusals must never enter this decoding hook.
    new URL(request.url).searchParams.get('workspace');
    return undefined;
  });
});
afterEach(() => expect(getChatIngressDiagnostics()).toMatchObject({ active: 0, parsing: 0, reservedBytes: 0 }));

it.each(methods)('refuses oversized raw URLs before the $method workspace decoding hook', async ({ method, handler }) => {
  // No NextRequest construction: framework pre-handler allocations are outside
  // this application-boundary test, and the raw string need not be decoded.
  const request = { method, url: `${url}?message=${'x'.repeat(CHAT_INGRESS_LIMITS.urlCharacters)}`, headers: new Headers() } as NextRequest;
  const response = await handler(request);
  expect(response.status).toBe(413); expect(wrapperHook).not.toHaveBeenCalled();
  expect(processChatCompletion).not.toHaveBeenCalled();
});

it.each(methods)('refuses excessive parameter work before the $method workspace decoding hook', async ({ method, handler }) => {
  const request = { method, url: `${url}?${'x=1&'.repeat(CHAT_INGRESS_LIMITS.queryParameters)}`, headers: new Headers() } as NextRequest;
  expect((await handler(request)).status).toBe(413);
  expect(wrapperHook).not.toHaveBeenCalled(); expect(processChatCompletion).not.toHaveBeenCalled();
});

it.each(methods)('refuses overload before the $method workspace decoding hook without releasing held owners', async ({ method, handler }) => {
  const held = [acquireChatIngress(new NextRequest(url)), acquireChatIngress(new NextRequest(url))];
  try {
    const response = await handler(new NextRequest(`${url}?workspace=default-workspace`, { method }));
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('5');
    expect(wrapperHook).not.toHaveBeenCalled(); expect(processChatCompletion).not.toHaveBeenCalled();
    expect(getChatIngressDiagnostics()).toMatchObject({ active: 2, reservedBytes: 2 * CHAT_INGRESS_LIMITS.parsingBytes });
  } finally { held.forEach(permit => permit.release()); }
});

it.each(methods)('holds exactly one permit through the accepted $method wrapper and handler', async ({ method, handler }) => {
  let admitted: ChatIngressPermit | undefined;
  wrapperHook.mockImplementationOnce(async (request, permit) => {
    expect(new URL(request.url).searchParams.get('workspace')).toBe('default-workspace');
    expect(getChatIngressDiagnostics()).toMatchObject({ active: 1, parsing: 1, reservedBytes: CHAT_INGRESS_LIMITS.parsingBytes });
    admitted = permit; return undefined;
  });
  jest.mocked(processChatCompletion).mockImplementationOnce(async (...args) => {
    expect(args[8]).toBe(admitted);
    expect(getChatIngressDiagnostics()).toMatchObject({ active: 1, parsing: 0 });
    return new Response('{}');
  });
  const request = new NextRequest(`${url}?workspace=default-workspace&model=model-test&message=hello`, { method,
    ...(method === 'POST' ? { body: '{"model":"model-test","messages":[]}' } : {}),
  });
  expect((await handler(request)).status).toBe(method === 'OPTIONS' ? 204 : 200);
  expect(wrapperHook).toHaveBeenCalledTimes(1);
  expect(processChatCompletion).toHaveBeenCalledTimes(method === 'OPTIONS' ? 0 : 1);
});

it.each(methods)('releases $method admission on wrapper authorization refusal', async ({ method, handler }) => {
  wrapperHook.mockImplementationOnce(async () => {
    expect(getChatIngressDiagnostics().active).toBe(1);
    return new Response('Unauthorized', { status: 401 });
  });
  expect((await handler(new NextRequest(url, { method }))).status).toBe(401);
  expect(processChatCompletion).not.toHaveBeenCalled();
});

it.each(methods)('releases $method admission when the workspace wrapper throws', async ({ method, handler }) => {
  const failure = new Error('workspace fixture failure');
  wrapperHook.mockRejectedValueOnce(failure);
  await expect(handler(new NextRequest(url, { method }))).rejects.toBe(failure);
  expect(processChatCompletion).not.toHaveBeenCalled();
});
