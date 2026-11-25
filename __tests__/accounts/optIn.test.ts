jest.mock('@/backend/services/workspace/layoutReadiness', () => ({
  waitForWorkspaceLayoutReady: async () => undefined,
  getWorkspaceLayoutStatus: () => 'ready',
}));
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  ensureWorkspaceDirs: async () => undefined,
}));

import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { GET as listWorkspacesRoute } from '@/app/api/workspaces/route';
import { POST as modeRoute } from '@/app/api/accounts/mode/route';
import { DELETE as signOutRoute, GET as sessionRoute, POST as signInRoute } from '@/app/api/accounts/session/route';
import { issueOwnerCredential } from '@/backend/services/security/ownerCredentials';
import { loadAccountsState } from '@/backend/services/accounts/store';
import { snapshotTree, useTemporaryDataDir } from './helpers';

/**
 * The hard rule of the multi-user plan (#574): without `accounts/accounts.json`
 * FLUJO behaves exactly as before, and turning the mode on and off again moves
 * or changes no byte of workspace data.
 */

const HOST = 'localhost:4200';
const PASSWORD = 'a long enough admin passphrase';

function request(method: string, route: string, headers: Record<string, string> = {}, body?: unknown) {
  return new NextRequest(`http://${HOST}${route}`, {
    method, headers: { host: HOST, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0];
}

describe('multi-user mode is opt-in', () => {
  let restore: () => Promise<void>;
  let dir: string;
  const handler = jest.fn(async () => Response.json({ ok: true }));
  const wrapped = withWorkspaceRoute(handler as never) as unknown as (request: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ dir, restore } = await useTemporaryDataDir());
    for (const name of ['default-workspace', 'team-notes']) {
      await fs.mkdir(path.join(dir, 'workspaces', name, 'db'), { recursive: true });
      await fs.writeFile(path.join(dir, 'workspaces', name, 'db', 'flows.json'), JSON.stringify({ name, flows: [1, 2, 3] }));
    }
    await fs.writeFile(path.join(dir, 'workspaces', 'default-workspace', 'db', 'encryption_key.json'), '{"keyring":"unchanged"}');
    handler.mockClear();
  });
  afterEach(async () => restore());

  it('reads no accounts file, adds no check and creates nothing while the mode is off', async () => {
    const readFile = jest.spyOn(fs, 'readFile');
    try {
      expect((await proxy(request('GET', '/api/flow'))).status).toBe(200);
      expect((await proxy(request('POST', '/api/update'))).status).toBe(200);
      expect((await wrapped(request('GET', '/api/flow'))).status).toBe(200);
      expect((await wrapped(request('GET', '/api/flow?workspace=team-notes'))).status).toBe(200);
      const listed = await (await listWorkspacesRoute(request('GET', '/api/workspaces'))).json() as { workspaces: Array<{ name: string }> };
      expect(listed.workspaces.map(workspace => workspace.name)).toEqual(['default-workspace', 'team-notes']);
      expect(readFile.mock.calls.filter(([file]) => String(file).includes(`${path.sep}accounts${path.sep}`))).toEqual([]);
    } finally {
      readFile.mockRestore();
    }
    expect(handler).toHaveBeenCalledTimes(2);
    await expect(fs.stat(path.join(dir, 'accounts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sessionRoute(request('GET', '/api/accounts/session')).then(response => response.json())).toEqual({ mode: 'off', user: null });
  });

  it('turns on and off again without changing a byte under workspaces/', async () => {
    const before = await snapshotTree(path.join(dir, 'workspaces'));
    const turnedOn = await modeRoute(request('POST', '/api/accounts/mode', {}, { enabled: true, name: 'Anna', password: PASSWORD }));
    expect(turnedOn.status).toBe(200);
    const adminCookie = cookieFrom(turnedOn);
    expect(adminCookie).toMatch(/^flujo-session=flo_a1_/);
    const state = await loadAccountsState();
    expect(state.mode).toBe('on');
    expect(Object.keys(state.accounts!.workspaces).sort()).toEqual(['default-workspace', 'team-notes']);

    expect((await wrapped(request('GET', '/api/flow'))).status).toBe(401);
    expect((await wrapped(request('GET', '/api/flow', { cookie: adminCookie }))).status).toBe(200);

    const turnedOff = await modeRoute(request('POST', '/api/accounts/mode', { cookie: adminCookie }, { enabled: false }));
    expect(turnedOff.status).toBe(200);
    expect((await loadAccountsState()).mode).toBe('off');
    expect((await wrapped(request('GET', '/api/flow'))).status).toBe(200);
    expect(await snapshotTree(path.join(dir, 'workspaces'))).toEqual(before);
  }, 60_000);

  it('signs in and out with a name and password, slowing down wrong guesses', async () => {
    await modeRoute(request('POST', '/api/accounts/mode', {}, { enabled: true, name: 'anna', password: PASSWORD }));
    const wrong = await signInRoute(request('POST', '/api/accounts/session', {}, { name: 'anna', password: 'not the right passphrase' }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('retry-after')).toBe('1');
    const tooSoon = await signInRoute(request('POST', '/api/accounts/session', {}, { name: 'anna', password: PASSWORD }));
    expect(tooSoon.status).toBe(429);
    expect(await tooSoon.json()).toMatchObject({ code: 'SIGN_IN_SLOWED' });
    await new Promise(resolve => setTimeout(resolve, 1100));
    const right = await signInRoute(request('POST', '/api/accounts/session', {}, { name: 'ANNA', password: PASSWORD }));
    expect(right.status).toBe(200);
    expect(right.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax; Max-Age=28800/);
    const cookie = cookieFrom(right);
    expect(await (await sessionRoute(request('GET', '/api/accounts/session', { cookie }))).json())
      .toMatchObject({ mode: 'on', user: { name: 'anna', role: 'admin' } });
    const crossSite = await signInRoute(request('POST', '/api/accounts/session', { origin: 'https://evil.example' }, { name: 'anna', password: PASSWORD }));
    expect(crossSite.status).toBe(403);
    expect((await signOutRoute(request('DELETE', '/api/accounts/session', { cookie }))).status).toBe(200);
    expect((await wrapped(request('GET', '/api/flow', { cookie }))).status).toBe(401);
  }, 60_000);

  it('keeps owner policy tokens working for the first admin', async () => {
    const policyFile = path.join(dir, 'owner.json');
    const issued = issueOwnerCredential(['openai:execute', 'control:admin', 'secrets:read'], Date.now() + 60_000);
    await fs.writeFile(policyFile, JSON.stringify({ schemaVersion: 1, ownerId: 'owner', credentials: [issued.record] }), { mode: 0o600 });
    const previous = process.env.FLUJO_OWNER_AUTH_FILE;
    process.env.FLUJO_OWNER_AUTH_FILE = policyFile;
    try {
      await modeRoute(request('POST', '/api/accounts/mode', {}, { enabled: true, name: 'anna', password: PASSWORD }));
    } finally {
      if (previous === undefined) delete process.env.FLUJO_OWNER_AUTH_FILE;
      else process.env.FLUJO_OWNER_AUTH_FILE = previous;
    }
    const state = await loadAccountsState();
    expect(state.accounts!.apiTokens).toEqual([expect.objectContaining({ id: issued.record.id, digest: issued.record.digest })]);
    const response = await wrapped(request('GET', '/api/flow?workspace=team-notes', { authorization: `Bearer ${issued.token}` }));
    expect(response.status).toBe(200);
  }, 60_000);
});
