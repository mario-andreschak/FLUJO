import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueOwnerCredential, type OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { bindOwnerStream } from '@/backend/services/security/ownerStream';
import { POST, DELETE } from '@/app/api/owner/session/route';
import { withWorkspaceRoute } from '@/app/api/_workspace';

jest.mock('@/backend/services/workspace/layoutReadiness', () => ({
  waitForWorkspaceLayoutReady: jest.fn(async () => undefined),
}));
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  ensureWorkspaceDirs: jest.fn(async () => undefined),
  workspaceExists: jest.fn(async () => true),
}));

let directory: string;
let filename: string;
let policy: OwnerPolicy;
let token: string;
let saved: Record<string, string | undefined>;
const origin = 'http://localhost:4200';
const encode = (value: string) => new TextEncoder().encode(value);
beforeEach(() => {
  saved = { FLUJO_OWNER_AUTH_FILE: process.env.FLUJO_OWNER_AUTH_FILE,
    FLUJO_OWNER_BROWSER_ORIGIN: process.env.FLUJO_OWNER_BROWSER_ORIGIN };
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-owner-stream-'));
  filename = path.join(directory, 'policy.json');
  const issued = issueOwnerCredential(['control:admin', 'secrets:read'], Date.now() + 60_000);
  token = issued.token;
  policy = { schemaVersion: 1, ownerId: 'owner', credentials: [issued.record] };
  persist();
  process.env.FLUJO_OWNER_AUTH_FILE = filename;
  process.env.FLUJO_OWNER_BROWSER_ORIGIN = origin;
});
afterEach(() => {
  jest.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function persist() { fs.writeFileSync(filename, JSON.stringify(policy), { mode: 0o600 }); }
function request(cookie?: string) {
  return new Request(`${origin}/api/events`, { headers: { host: 'localhost:4200', origin,
    ...(cookie ? { cookie } : { authorization: `Bearer ${token}` }) } });
}
function open(cookie?: string, signal = new AbortController().signal) {
  const admission = resolveOwnerRequest(request(cookie));
  if (!admission.ok) throw new Error('Fixture admission denied');
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = jest.fn();
  const upstream = new ReadableStream<Uint8Array>({ start(value) { producer = value; }, cancel });
  const response = bindOwnerStream(new Response(upstream, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8', 'X-Fixture': 'preserved',
  } }), admission.authorization, signal);
  return { response, producer, cancel };
}
test('preserves authorized bytes and headers and cancels the producer on consumer cancellation', async () => {
  const { response, producer, cancel } = open();
  const reader = response.body!.getReader();
  producer.enqueue(encode('data: allowed\n\n'));
  expect(await reader.read()).toEqual({ value: encode('data: allowed\n\n'), done: false });
  expect(response.headers.get('x-fixture')).toBe('preserved');
  await reader.cancel();
  expect(cancel).toHaveBeenCalledTimes(1);
});
test('discards queued bytes after durable revocation and denies reconnection', async () => {
  const { response, producer, cancel } = open();
  producer.enqueue(encode('data: private\n\n'));
  policy.credentials[0].revokedAt = Date.now(); persist();
  await expect(response.body!.getReader().read()).rejects.toThrow('Stream authorization ended.');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(resolveOwnerRequest(request()).ok).toBe(false);
});
test('rechecks after a pending read resolves so racing output cannot disclose data', async () => {
  const { response, producer, cancel } = open();
  const read = response.body!.getReader().read();
  await Promise.resolve();
  policy.credentials[0].revokedAt = Date.now(); persist();
  producer.enqueue(encode('data: raced\n\n'));
  await expect(read).rejects.toThrow('Stream authorization ended.');
  expect(cancel).toHaveBeenCalledTimes(1);
});
test('revokes an idle backpressured stream without waiting for another event', async () => {
  jest.useFakeTimers();
  const { response, cancel } = open();
  policy.credentials[0].revokedAt = Date.now(); persist();
  jest.advanceTimersByTime(1000);
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(response.body!.getReader().read()).rejects.toThrow('Stream authorization ended.');
  expect(jest.getTimerCount()).toBe(0);
});
test('logout revokes an already established cookie-authenticated stream', async () => {
  const login = POST(new Request(`${origin}/api/owner/session`, { method: 'POST', headers: {
    host: 'localhost:4200', origin, authorization: `Bearer ${token}`,
  } }));
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const { response, producer, cancel } = open(cookie);
  expect(DELETE(new Request(`${origin}/api/owner/session`, { method: 'DELETE', headers: {
    host: 'localhost:4200', origin, cookie,
  } })).status).toBe(200);
  producer.enqueue(encode('data: private\n\n'));
  await expect(response.body!.getReader().read()).rejects.toThrow('Stream authorization ended.');
  expect(cancel).toHaveBeenCalledTimes(1);
});
test('expiry and corrupt policy stop an established stream with generic errors', async () => {
  jest.useFakeTimers();
  const first = open();
  jest.setSystemTime(policy.credentials[0].expiresAt);
  jest.advanceTimersByTime(1000);
  await expect(first.response.body!.getReader().read()).rejects.toThrow('Stream authorization ended.');
  jest.useRealTimers();
  const second = open();
  fs.writeFileSync(filename, 'private-invalid-policy');
  second.producer.enqueue(encode('data: secret\n\n'));
  await expect(second.response.body!.getReader().read()).rejects.toThrow('Stream authorization ended.');
  expect(second.cancel).toHaveBeenCalledTimes(1);
});
test('request abort cancels the producer and releases the revocation timer', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const { response, cancel } = open(undefined, controller.signal);
  controller.abort();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  await expect(response.body!.getReader().read()).rejects.toThrow('Stream authorization ended.');
});
test('normal completion releases the timer without canceling successful work', async () => {
  jest.useFakeTimers();
  const { response, producer, cancel } = open();
  producer.close();
  expect(await response.body!.getReader().read()).toEqual({ done: true, value: undefined });
  expect(cancel).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
test('the real workspace route wrapper cancels its established producer and refuses reconnection', async () => {
  const cancel = jest.fn();
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const handler = jest.fn(async (_request: Request) => new Response(new ReadableStream<Uint8Array>({
    start(value) { producer = value; }, cancel,
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const route = withWorkspaceRoute(handler);
  const response = await route(request());
  expect(response.status).toBe(200);
  policy.credentials[0].revokedAt = Date.now(); persist();
  producer.enqueue(encode('data: protected\n\n'));
  await expect(response.body!.getReader().read()).rejects.toThrow('Stream authorization ended.');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect((await route(request())).status).toBe(401);
  expect(handler).toHaveBeenCalledTimes(1);
});
