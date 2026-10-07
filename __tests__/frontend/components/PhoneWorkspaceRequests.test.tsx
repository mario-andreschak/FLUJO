import { TextEncoder, TextDecoder } from 'node:util';
import { ReadableStream, TransformStream } from 'node:stream/web';
import { MessagePort } from 'node:worker_threads';
import { bindPhoneHostRequests, initializeWorkspaceSelection, __resetWorkspaceSelectionForTests } from '@/frontend/utils/workspaceSelection';

// jsdom has no native fetch primitives; use the locked runtime implementation.
const nativeGlobalNames = ['TextEncoder', 'TextDecoder', 'ReadableStream', 'TransformStream', 'MessagePort', 'Request', 'Response', 'Headers'] as const;
const originalGlobals = nativeGlobalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
beforeAll(() => {
  Object.assign(globalThis, { TextEncoder, TextDecoder, ReadableStream, TransformStream, MessagePort });
  const { Request, Response, Headers } = jest.requireActual<typeof import('undici')>('undici');
  Object.assign(globalThis, { Request, Response, Headers });
});
afterAll(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

let lifetime: AbortController;
let upstream: jest.Mock;
beforeEach(() => {
  __resetWorkspaceSelectionForTests();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/world?workspace=worker-fixture');
  lifetime = new AbortController();
  upstream = jest.fn(async () => new Response('{}'));
  window.fetch = upstream;
  bindPhoneHostRequests({ csrf: 'actual-phone-csrf', workspace: 'worker-fixture', signal: lifetime.signal, onAccessEnded: jest.fn() });
  initializeWorkspaceSelection();
});
afterEach(() => { lifetime.abort(); __resetWorkspaceSelectionForTests(); });

test('native Request writes preserve body, method, original headers and abort with captured phone CSRF', async () => {
  const caller = new AbortController();
  const request = new Request('http://localhost/v1/chat/completions', {
    method: 'POST', body: '{"conversationId":"existing-id"}', signal: caller.signal,
    headers: { 'Content-Type': 'application/json', 'x-original': 'preserved', 'x-phone-csrf': 'caller-value' },
  });
  await window.fetch(request);
  const sent = upstream.mock.calls[0][0] as Request;
  expect(sent.method).toBe('POST');
  expect(await sent.clone().text()).toBe('{"conversationId":"existing-id"}');
  expect(sent.headers.get('x-phone-csrf')).toBe('actual-phone-csrf');
  expect(sent.headers.get('x-original')).toBe('preserved');
  expect(new URL(sent.url).searchParams.get('workspace')).toBe('worker-fixture');
  caller.abort(); expect(sent.signal.aborted).toBe(true);
});

test('native reads and external provider requests never receive phone CSRF', async () => {
  await window.fetch('/api/avatar/world');
  expect(new Headers(upstream.mock.calls[0][1]?.headers).has('x-phone-csrf')).toBe(false);
  await window.fetch('https://provider.example.test/endpoint', { method: 'POST', body: '{}' });
  expect(upstream.mock.calls[1][0]).toBe('https://provider.example.test/endpoint');
  expect(new Headers(upstream.mock.calls[1][1]?.headers).has('x-phone-csrf')).toBe(false);
});

test('caller workspace changes and retired phone scopes are rejected before native dispatch', async () => {
  await expect(window.fetch('/api/settings?workspace=other-workspace', { method: 'PUT', body: '{}' })).rejects.toMatchObject({ name: 'AbortError' });
  await expect(window.fetch('/api/settings', { method: 'PUT', headers: { 'x-flujo-workspace': 'other-workspace' }, body: '{}' })).rejects.toMatchObject({ name: 'AbortError' });
  bindPhoneHostRequests();
  await expect(window.fetch('/api/avatar/world')).rejects.toMatchObject({ name: 'AbortError' });
  expect(upstream).not.toHaveBeenCalled();
});

test('scope revocation cancels a late response with one dispatch and no work replay', async () => {
  let resolve!: (response: Response) => void;
  upstream.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  const pending = window.fetch('/v1/chat/completions', { method: 'POST', body: '{"conversationId":"existing-id"}' });
  lifetime.abort();
  let cancelled = false;
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled).toBe(true);
  expect(upstream).toHaveBeenCalledTimes(1);
});
