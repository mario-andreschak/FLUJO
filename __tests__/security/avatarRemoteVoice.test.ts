import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

// Only workspace storage/startup is substituted. Admission and durable owner
// policies are real; this suite does not qualify Next, Docker or a provider.
jest.mock('@/utils/workspace', () => {
  const { AsyncLocalStorage } = jest.requireActual<typeof import('node:async_hooks')>('node:async_hooks');
  const selected = new AsyncLocalStorage<string>();
  return {
    workspaceExists: jest.fn(async () => true),
    getCurrentWorkspace: () => selected.getStore(),
    runWithWorkspace: (workspace: string, callback: () => unknown) => selected.run(workspace, callback),
  };
});
jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: jest.fn((handler: (request: Request, ...rest: unknown[]) => unknown) =>
    async (request: Request, ...rest: unknown[]) => {
      const { isWorkerMode } = jest.requireActual('@/backend/services/workspace/workerMode');
      const denied = isWorkerMode()
        ? jest.requireActual('@/backend/services/workspace/snapshotControlAuth').assertSnapshotBearer(request)
        : jest.requireActual('@/backend/services/security/ownerAccess').assertOwnerRequest(request);
      if (denied) return denied;
      const { runWithWorkspace } = jest.requireMock('@/utils/workspace');
      const workspace = new URL(request.url).searchParams.get('workspace') ?? request.headers.get('x-flujo-workspace');
      return runWithWorkspace(workspace, () => handler(request, ...rest));
    }),
}));

import { withRemoteAvatarRoute, disposeAvatarRemoteScopes } from '@/backend/services/avatar/remoteVoice';
import { issueOwnerCredential, type OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { workspaceExists, getCurrentWorkspace } from '@/utils/workspace';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { setWorkerBootstrapStatus, type WorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';

type Handler = Parameters<typeof withRemoteAvatarRoute>[0];
type Trusted = Parameters<Handler>[1];
type Route = ReturnType<typeof withRemoteAvatarRoute>;
const ROUTE = '/api/avatar/remote/native-turn';
const encoder = new TextEncoder();
const savedEnvironment = Object.fromEntries([
  'FLUJO_OWNER_AUTH_FILE', 'FLUJO_AVATAR_REMOTE_ORIGIN', 'FLUJO_WORKER_MODE', 'FLUJO_SNAPSHOT_CONTROL_TOKEN',
].map(key => [key, process.env[key]]));
let directory: string;
let filename: string;
let token: string;
let policy: OwnerPolicy;
let savedWorkerBootstrap: WorkerBootstrapStatus | undefined;
const servers: http.Server[] = [];

function persist() {
  fs.writeFileSync(`${filename}.new`, JSON.stringify(policy), { mode: 0o600 });
  fs.renameSync(`${filename}.new`, filename);
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually(check: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Bounded fixture observation timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function request(extra: Record<string, string> = {}, url = `https://voice.example.test${ROUTE}`, bearer: string | null = token) {
  return new Request(url, { method: 'POST', headers: {
    origin: 'https://voice.example.test', 'content-type': 'application/json',
    'x-flujo-avatar-client': randomUUID(), ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...extra,
  }, body: '{"message":"synthetic"}' });
}

/** Own loopback adapter, deliberately smaller than a Next server. */
async function serve(route: Route) {
  const server = http.createServer(async (incoming, outgoing) => {
    const disconnected = new AbortController();
    const abort = () => disconnected.abort();
    incoming.once('aborted', abort);
    outgoing.once('close', () => { if (!outgoing.writableEnded) abort(); });
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    }
    const init: RequestInit & { duplex: 'half' } = {
      method: incoming.method, headers, body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
      signal: disconnected.signal, duplex: 'half',
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await route(new Request(`http://${incoming.headers.host}${incoming.url}`, init));
      if (outgoing.destroyed) { await response.body?.cancel(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      reader = response.body?.getReader();
      const cancel = () => { void reader?.cancel().catch(() => {}); };
      disconnected.signal.addEventListener('abort', cancel, { once: true });
      if (disconnected.signal.aborted) cancel();
      if (reader) while (!disconnected.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!outgoing.write(Buffer.from(chunk.value))) await once(outgoing, 'drain');
      }
      if (!outgoing.destroyed) outgoing.end();
      disconnected.signal.removeEventListener('abort', cancel);
    } catch {
      outgoing.destroy();
    } finally {
      reader?.releaseLock();
      incoming.removeListener('aborted', abort);
    }
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Invalid owned HTTP fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.FLUJO_AVATAR_REMOTE_ORIGIN = origin;
  return { origin, url: `${origin}${ROUTE}` };
}
function httpHeaders(origin: string) {
  return { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json', 'x-flujo-avatar-client': randomUUID() };
}

beforeEach(() => {
  savedWorkerBootstrap = global.__flujo_worker_bootstrap_status;
  delete global.__flujo_worker_bootstrap_status;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-avatar-remote-test-'));
  filename = path.join(directory, 'owner.json');
  const issued = issueOwnerCredential(['avatar:voice'], Date.now() + 60_000, Date.now() - 1000, { workspaceId: 'workspace-alpha' });
  token = issued.token;
  policy = { schemaVersion: 1, ownerId: 'synthetic-owner', credentials: [issued.record] };
  persist();
  process.env.FLUJO_OWNER_AUTH_FILE = filename;
  process.env.FLUJO_AVATAR_REMOTE_ORIGIN = 'https://voice.example.test';
  delete process.env.FLUJO_WORKER_MODE;
  delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  jest.clearAllMocks();
  jest.mocked(workspaceExists).mockResolvedValue(true);
});
afterEach(async () => {
  await disposeAvatarRemoteScopes();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  const real = fs.realpathSync(directory);
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !/^flujo-avatar-remote-test-[A-Za-z0-9]+$/.test(path.basename(real))) {
    throw new Error('Unsafe owned test fixture cleanup');
  }
  fs.rmSync(real, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  global.__flujo_worker_bootstrap_status = savedWorkerBootstrap;
});

test.each([
  ['missing bearer', () => request({}, undefined, null), 401, true],
  ['invalid bearer', () => request({}, undefined, 'not-a-token'), 401, true],
  ['missing origin', () => { const req = request(); req.headers.delete('origin'); return req; }, 403, true],
  ['different origin', () => request({ origin: 'https://attacker.example.test' }), 403, true],
  ['forged forwarding cannot rescue a different origin', () => request({ origin: 'https://attacker.example.test',
    'x-forwarded-host': 'voice.example.test', 'x-forwarded-proto': 'https' }), 403, true],
  ['same host different port', () => request({ origin: 'https://voice.example.test:4430' }), 403, true],
  ['different workspace query', () => request({}, `https://voice.example.test${ROUTE}?workspace=workspace-beta`), 403, false],
  ['different workspace header', () => request({ 'x-flujo-workspace': 'workspace-beta' }), 403, false],
  ['duplicate workspace selection', () => request({}, `https://voice.example.test${ROUTE}?workspace=workspace-alpha&workspace=workspace-beta`), 403, false],
] as const)('denies %s before body, workspace selection or handler', async (_label, make, status, beforeStorage) => {
  const handler = jest.fn(async () => Response.json({ shouldNotRun: true }));
  const req = make();
  const response = await withRemoteAvatarRoute(handler)(req);
  expect(response.status).toBe(status);
  expect(req.bodyUsed).toBe(false);
  expect(handler).not.toHaveBeenCalled();
  expect(withWorkspaceRoute).not.toHaveBeenCalled();
  if (beforeStorage) expect(workspaceExists).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain(token);
});

test('refuses missing/corrupt policy and unconfigured or non-loopback HTTP origin', async () => {
  const handler = jest.fn(async () => new Response('unused'));
  const route = withRemoteAvatarRoute(handler);
  delete process.env.FLUJO_OWNER_AUTH_FILE;
  expect((await route(request())).status).toBe(503);
  process.env.FLUJO_OWNER_AUTH_FILE = filename;
  fs.writeFileSync(filename, '{broken', { mode: 0o600 });
  expect((await route(request())).status).toBe(503);
  persist();
  delete process.env.FLUJO_AVATAR_REMOTE_ORIGIN;
  expect((await route(request())).status).toBe(503);
  process.env.FLUJO_AVATAR_REMOTE_ORIGIN = 'http://voice.example.test';
  expect((await route(request({ origin: 'http://voice.example.test' }, `http://voice.example.test${ROUTE}`))).status).toBe(503);
  expect(handler).not.toHaveBeenCalled();
});

test('rejects a control/secret grant and a voice grant without durable workspace binding', async () => {
  const handler = jest.fn(async () => new Response('unused'));
  const admin = issueOwnerCredential(['control:admin', 'secrets:read'], Date.now() + 60_000);
  policy.credentials.push(admin.record); persist();
  expect((await withRemoteAvatarRoute(handler)(request({}, undefined, admin.token))).status).toBe(403);
  delete policy.credentials[0].workspaceId; persist();
  expect((await withRemoteAvatarRoute(handler)(request())).status).toBe(403);
  expect(handler).not.toHaveBeenCalled();
});

test('availability GET admits a voice-only grant through the repeated real owner guard', async () => {
  const req = new Request('https://voice.example.test/api/avatar/remote/availability', {
    headers: { origin: 'https://voice.example.test', authorization: `Bearer ${token}` },
  });
  const response = await withRemoteAvatarRoute(async () => Response.json({ available: true }))(req);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ available: true });
});

test.each([
  ['snapshot only', 'snapshot-test-only', null, 401],
  ['voice in ordinary Authorization only', 'voice', null, 401],
  ['voice only in its own header', null, 'voice', 401],
  ['forged voice header with valid snapshot', 'snapshot-test-only', 'forged-voice', 401],
  ['both independent grants', 'snapshot-test-only', 'voice', 200],
] as const)('worker mode requires independent grants: %s', async (_label, snapshot, voice, status) => {
  process.env.FLUJO_WORKER_MODE = '1';
  process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'snapshot-test-only';
  setWorkerBootstrapStatus({ state: 'ready', workspace: 'workspace-alpha' });
  const req = request({}, undefined, null);
  if (snapshot !== null) req.headers.set('authorization', `Bearer ${snapshot === 'voice' ? token : snapshot}`);
  if (voice !== null) req.headers.set('x-flujo-avatar-authorization', `Bearer ${voice === 'voice' ? token : voice}`);
  const handler = jest.fn(async () => new Response('ok'));
  const response = await withRemoteAvatarRoute(handler)(req);
  expect(response.status).toBe(status);
  if (status === 200) { expect(handler).toHaveBeenCalledTimes(1); await response.text(); }
  else {
    expect(handler).not.toHaveBeenCalled();
    expect(workspaceExists).not.toHaveBeenCalled();
  }
});

test('pins identity and selected workspace to the policy, separating grants with the same client ID', async () => {
  const second = issueOwnerCredential(['avatar:voice'], Date.now() + 60_000, Date.now() - 1000, { workspaceId: 'workspace-beta' });
  policy.credentials.push(second.record); persist();
  const observed: Array<{ workspace: string; selected: string; scope: string }> = [];
  const route = withRemoteAvatarRoute(async (_req, trusted) => {
    await trusted.recheck();
    observed.push({ workspace: trusted.workspace, selected: getCurrentWorkspace(), scope: trusted.scopeKey });
    return new Response('ok');
  });
  const client = randomUUID();
  const claims = { 'x-flujo-avatar-client': client, 'x-flujo-owner': 'forged-owner', cookie: 'owner=forged-owner' };
  await (await route(request(claims))).text();
  await (await route(request(claims, undefined, second.token))).text();
  expect(observed.map(value => [value.workspace, value.selected])).toEqual([
    ['workspace-alpha', 'workspace-alpha'], ['workspace-beta', 'workspace-beta'],
  ]);
  expect(observed[0].scope).not.toBe(observed[1].scope);
  expect(JSON.stringify(observed)).not.toContain(token);
  expect(JSON.stringify(observed)).not.toContain(second.token);
  expect(JSON.stringify(observed)).not.toContain('forged-owner');
});

test('rechecks disappearing workspace before an awaited handler effect', async () => {
  let effects = 0;
  const route = withRemoteAvatarRoute(async (_req, trusted) => {
    jest.mocked(workspaceExists).mockResolvedValue(false);
    await trusted.recheck();
    effects++;
    return new Response('unused');
  });
  expect((await route(request())).status).toBeGreaterThanOrEqual(400);
  expect(effects).toBe(0);
});

test('genuine HTTP delivers the first byte while the provider fixture remains open', async () => {
  let provider!: ReadableStreamDefaultController<Uint8Array>;
  const route = withRemoteAvatarRoute(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    provider = controller; controller.enqueue(encoder.encode('first\n'));
  } }), { headers: { 'content-type': 'application/x-ndjson' } }));
  const { origin, url } = await serve(route);
  const response = await fetch(url, { method: 'POST', headers: httpHeaders(origin), body: '{}' });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n');
  provider.enqueue(encoder.encode('last\n')); provider.close();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('last\n');
  expect((await reader.read()).done).toBe(true);
  reader.releaseLock();
});

test.each(['revoked', 'expired', 'configuration switched', 'workspace disappears'] as const)('genuine HTTP cancels an open provider stream when %s', async reason => {
  if (reason === 'expired') { policy.credentials[0].expiresAt = Date.now() + 800; persist(); }
  let trusted!: Trusted;
  const cancelled = jest.fn();
  const route = withRemoteAvatarRoute(async (_req, context) => {
    trusted = context;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('first\n')); }, cancel: cancelled,
    }));
  });
  const { origin, url } = await serve(route);
  const response = await fetch(url, { method: 'POST', headers: httpHeaders(origin), body: '{}' });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n');
  if (reason === 'revoked') { policy.credentials[0].revokedAt = Date.now(); persist(); }
  if (reason === 'configuration switched') process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'missing-policy.json');
  if (reason === 'workspace disappears') jest.mocked(workspaceExists).mockResolvedValue(false);
  await eventually(() => trusted.revokeSignal.aborted && cancelled.mock.calls.length > 0);
  try { await reader.read(); } catch { /* A terminated genuine HTTP stream is expected. */ }
  reader.releaseLock();
  await expect(trusted.recheck()).rejects.toMatchObject({ status: expect.any(Number) });
});

test('revocation during a genuine partial HTTP upload prevents an effect after its body await', async () => {
  const entered = deferred<Trusted>();
  let effects = 0;
  const route = withRemoteAvatarRoute(async (req, trusted) => {
    entered.resolve(trusted);
    await req.text();
    await trusted.recheck();
    effects++;
    return new Response('unused');
  });
  const { origin, url } = await serve(route);
  const outgoing = http.request(url, { method: 'POST', headers: httpHeaders(origin) });
  const finished = new Promise<{ status?: number; error?: Error }>(resolve => {
    outgoing.on('response', response => { response.resume(); response.once('end', () => resolve({ status: response.statusCode })); });
    outgoing.on('error', error => resolve({ error }));
  });
  outgoing.write('{"recording":');
  const trusted = await entered.promise;
  policy.credentials[0].revokedAt = Date.now(); persist();
  await eventually(() => trusted.revokeSignal.aborted);
  outgoing.end('"synthetic"}');
  const terminal = await finished;
  expect(terminal.error || (terminal.status !== undefined && terminal.status >= 400)).toBeTruthy();
  expect(effects).toBe(0);
});

test('durable revocation interrupts an HTTP stream while workspace validation is pending', async () => {
  let trusted!: Trusted;
  const cancelled = jest.fn();
  const route = withRemoteAvatarRoute(async (_req, context) => {
    trusted = context;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('first\n')); }, cancel: cancelled,
    }));
  });
  const { origin, url } = await serve(route);
  const response = await fetch(url, { method: 'POST', headers: httpHeaders(origin), body: '{}' });
  const reader = response.body!.getReader();
  await reader.read();
  const blocked = deferred<void>();
  const release = deferred<boolean>();
  jest.mocked(workspaceExists).mockImplementation(async () => { blocked.resolve(); return release.promise; });
  await blocked.promise;
  policy.credentials[0].revokedAt = Date.now(); persist();
  try {
    await eventually(() => trusted.revokeSignal.aborted && cancelled.mock.calls.length > 0, 1200);
  } finally {
    release.resolve(true);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
});

test('client abort during initial workspace validation settles independently of another client on the same grant', async () => {
  const entered = deferred<void>();
  const release = deferred<boolean>();
  jest.mocked(workspaceExists).mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
  const handler = jest.fn(async () => new Response('other client completed'));
  const route = withRemoteAvatarRoute(handler);
  const caller = new AbortController();
  let cancelledSettled = false;
  let otherSettled = false;
  const cancelled = route(new Request(request(), { signal: caller.signal })).then(response => {
    cancelledSettled = true;
    return response;
  });
  await entered.promise;
  const other = route(request()).then(response => { otherSettled = true; return response; });
  caller.abort();
  try {
    await eventually(() => cancelledSettled, 900);
    expect((await cancelled).status).toBeGreaterThanOrEqual(400);
    expect(otherSettled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    release.resolve(true);
    const completed = await other;
    expect(completed.status).toBe(200);
    expect(await completed.text()).toBe('other client completed');
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(true);
    await Promise.allSettled([cancelled, other]);
  }
});

test.each(['snapshot rotation', 'worker retirement', 'worker mode change'] as const)('genuine HTTP aborts worker voice on %s', async reason => {
  process.env.FLUJO_WORKER_MODE = '1';
  process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'snapshot-test-only';
  setWorkerBootstrapStatus({ state: 'ready', workspace: 'workspace-alpha' });
  let trusted!: Trusted;
  const cancelled = jest.fn();
  const route = withRemoteAvatarRoute(async (_req, context) => {
    trusted = context;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('first\n')); }, cancel: cancelled,
    }));
  });
  const { origin, url } = await serve(route);
  const response = await fetch(url, { method: 'POST', body: '{}', headers: {
    ...httpHeaders(origin), authorization: 'Bearer snapshot-test-only', 'x-flujo-avatar-authorization': `Bearer ${token}`,
  } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  await reader.read();
  if (reason === 'snapshot rotation') process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'snapshot-test-only-rotated';
  if (reason === 'worker retirement') setWorkerBootstrapStatus({ state: 'error' });
  if (reason === 'worker mode change') delete process.env.FLUJO_WORKER_MODE;
  await eventually(() => trusted.revokeSignal.aborted && cancelled.mock.calls.length > 0);
  await reader.cancel().catch(() => {});
  reader.releaseLock();
});

test('genuine HTTP client disconnect cancels its provider without revoking the grant', async () => {
  let trusted!: Trusted;
  const cancelled = jest.fn();
  const route = withRemoteAvatarRoute(async (_req, context) => {
    trusted = context;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('first\n')); }, cancel: cancelled,
    }));
  });
  const { origin, url } = await serve(route);
  const controller = new AbortController();
  const response = await fetch(url, { method: 'POST', headers: httpHeaders(origin), body: '{}', signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read(); controller.abort();
  await eventually(() => cancelled.mock.calls.length > 0);
  expect(trusted.revokeSignal.aborted).toBe(false);
  await expect(trusted.recheck()).resolves.toBeUndefined();
  reader.releaseLock();
});
