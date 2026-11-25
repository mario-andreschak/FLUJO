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
import { currentAccountPrincipal } from '@/backend/services/accounts/context';
import { createAccountSession } from '@/backend/services/accounts/sessions';
import { mutateAccounts } from '@/backend/services/accounts/store';
import { issueAccountToken } from '@/backend/services/accounts/tokens';
import { hashPassword } from '@/backend/services/accounts/passwords';
import { getCurrentWorkspace } from '@/utils/workspace';
import type { AccountUser } from '@/shared/types/accounts';
import { TEST_LOG_N, useTemporaryDataDir } from './helpers';

/**
 * Two people, each with a personal workspace, against the real proxy and the
 * real workspace wrapper (#574). Person B must get exactly the answer for a
 * workspace that does not exist when B names A's workspace, whichever way it
 * is named, and A's handler must never run.
 */

const HOST = 'localhost:4200';
const now = Date.now();
const user = (id: string, name: string, role: 'admin' | 'member', passwordHash: string): AccountUser => ({
  id, name, displayName: name, passwordHash, role, hostAccess: false, disabled: false, generation: 1, createdAt: now - 1000,
});

/** One route per kind of action in the plan's matrix: list, read, write, delete, run, approve, subscribe, export. */
const MATRIX: ReadonlyArray<readonly [action: string, method: string, route: string]> = [
  ['list', 'GET', '/api/flow'],
  ['read', 'GET', '/api/flow/f1'],
  ['read', 'GET', '/v1/chat/conversations/c1'],
  ['write', 'POST', '/api/flow'],
  ['write', 'PUT', '/api/model/m1'],
  ['delete', 'DELETE', '/api/flow/f1'],
  ['delete', 'DELETE', '/v1/chat/conversations/c1'],
  ['run', 'POST', '/api/planned-executions/p1/run'],
  ['run', 'POST', '/v1/chat/completions'],
  ['run', 'POST', '/api/mcp/servers/bash/tools/run'],
  ['approve', 'POST', '/api/approvals/a1'],
  ['approve', 'POST', '/v1/chat/conversations/c1/respond'],
  ['subscribe', 'GET', '/v1/chat/events'],
  ['subscribe', 'GET', '/api/mcp/servers/bash/events'],
  ['export', 'POST', '/api/backup'],
  ['export', 'GET', '/v1/personas/p1/export'],
  ['export', 'GET', '/api/env'],
];

describe('two people cannot reach each other\'s workspaces', () => {
  let restore: () => Promise<void>;
  let dir: string;
  let annaCookie: string;
  let benCookie: string;
  let benToken: string;
  let adminCookie: string;

  beforeAll(async () => {
    ({ dir, restore } = await useTemporaryDataDir());
    for (const name of ['default-workspace', 'anna-ws', 'ben-ws']) await fs.mkdir(path.join(dir, 'workspaces', name), { recursive: true });
    const hash = await hashPassword('a long enough test passphrase', TEST_LOG_N);
    const admin = user('u_admin00000000000000', 'admin', 'admin', hash);
    const anna = user('u_anna000000000000000', 'anna', 'member', hash);
    const ben = user('u_ben0000000000000000', 'ben', 'member', hash);
    const issued = issueAccountToken({ userId: ben.id, scopes: ['openai:execute', 'control:admin', 'secrets:read', 'mcp:access'] });
    benToken = issued.token;
    await mutateAccounts(() => ({
      schemaVersion: 1, enabled: true, revision: 0, users: [admin, anna, ben], teams: [],
      workspaces: {
        'default-workspace': { ownerType: 'user', ownerId: admin.id, assignedAt: now },
        'anna-ws': { ownerType: 'user', ownerId: anna.id, assignedAt: now },
        'ben-ws': { ownerType: 'user', ownerId: ben.id, assignedAt: now },
      },
      apiTokens: [issued.record],
    }));
    const cookie = async (person: AccountUser) => `flujo-session=${(await createAccountSession(person)).token}`;
    annaCookie = await cookie(anna);
    benCookie = await cookie(ben);
    adminCookie = await cookie(admin);
  });
  afterAll(async () => restore());

  function request(method: string, route: string, headers: Record<string, string> = {}) {
    return new NextRequest(`http://${HOST}${route}`, { method, headers: { host: HOST, ...headers } });
  }
  const select = (route: string, workspace: string) => `${route}${route.includes('?') ? '&' : '?'}workspace=${workspace}`;

  const handler = jest.fn(async () => Response.json({ workspace: getCurrentWorkspace(), userId: currentAccountPrincipal()?.userId ?? null }));
  const wrapped = withWorkspaceRoute(handler as never) as unknown as (request: Request) => Promise<Response>;
  beforeEach(() => handler.mockClear());

  async function expectNotFoundLikeUnknown(response: Response, workspace: string) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: `Unknown workspace: ${workspace}` });
  }

  it.each(MATRIX)('%s: %s %s answers 404 for the other person (query, header, API token)', async (_action, method, route) => {
    for (const forged of [
      request(method, select(route, 'anna-ws'), { cookie: benCookie }),
      request(method, route, { cookie: benCookie, 'x-flujo-workspace': 'anna-ws' }),
      request(method, select(route, 'anna-ws'), { authorization: `Bearer ${benToken}` }),
      request(method, route, { authorization: `Bearer ${benToken}`, 'x-flujo-workspace': 'anna-ws' }),
    ]) {
      const fromProxy = await proxy(forged);
      await expectNotFoundLikeUnknown(fromProxy, 'anna-ws');
      await expectNotFoundLikeUnknown(await wrapped(forged.clone() as Request), 'anna-ws');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(MATRIX)('%s: %s %s still works for the owner and carries the person to the handler', async (_action, method, route) => {
    const own = await wrapped(request(method, select(route, 'ben-ws'), { cookie: benCookie }));
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ workspace: 'ben-ws', userId: 'u_ben0000000000000000' });
    const proxied = await proxy(request(method, select(route, 'ben-ws'), { cookie: benCookie }));
    expect(proxied.status).toBe(200);
  });

  it('answers a guessed workspace name exactly like an unknown one', async () => {
    const guessed = await wrapped(request('GET', select('/api/flow', 'anna-ws'), { cookie: benCookie }));
    const unknown = await wrapped(request('GET', select('/api/flow', 'ghost-ws'), { cookie: benCookie }));
    expect(guessed.status).toBe(unknown.status);
    expect(await guessed.json()).toEqual({ error: 'Unknown workspace: anna-ws' });
    expect(await unknown.json()).toEqual({ error: 'Unknown workspace: ghost-ws' });
    expect([...guessed.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());
  });

  it('never falls back to the default workspace for a person who does not own it', async () => {
    await expectNotFoundLikeUnknown(await wrapped(request('GET', '/api/flow', { cookie: benCookie })), 'default-workspace');
    expect(handler).not.toHaveBeenCalled();
  });

  it('asks for sign-in without a session, with a forged session cookie or a forged token', async () => {
    for (const anonymous of [
      request('GET', select('/api/flow', 'anna-ws')),
      request('GET', select('/api/flow', 'anna-ws'), { cookie: 'flujo-session=flo_a1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
      request('GET', select('/api/flow', 'anna-ws'), { authorization: 'Bearer flo_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    ]) {
      const response = await proxy(anonymous);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'ACCOUNT_SIGN_IN_REQUIRED' });
      expect((await wrapped(anonymous.clone() as Request)).status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps host and admin routes from ordinary members', async () => {
    const browse = await proxy(request('GET', select('/api/browse', 'ben-ws'), { cookie: benCookie }));
    expect(browse.status).toBe(403);
    expect(await browse.json()).toMatchObject({ code: 'HOST_ACCESS_REQUIRED' });
    const update = await proxy(request('POST', '/api/update', { cookie: benCookie }));
    expect(update.status).toBe(403);
    expect(await update.json()).toMatchObject({ code: 'ADMIN_REQUIRED' });
    expect((await proxy(request('POST', '/api/update', { cookie: adminCookie }))).status).toBe(200);
    expect((await proxy(request('GET', '/api/no-such-route', { cookie: benCookie }))).status).toBe(403);
  });

  it('lets an admin open every workspace', async () => {
    const response = await wrapped(request('GET', select('/api/flow', 'anna-ws'), { cookie: adminCookie }));
    expect(await response.json()).toEqual({ workspace: 'anna-ws', userId: 'u_admin00000000000000' });
  });

  it('lists only each person\'s own workspaces', async () => {
    const names = async (cookie: string) => ((await (await listWorkspacesRoute(request('GET', '/api/workspaces', { cookie })))
      .json()) as { workspaces: Array<{ name: string }> }).workspaces.map(workspace => workspace.name);
    expect(await names(annaCookie)).toEqual(['anna-ws']);
    expect(await names(benCookie)).toEqual(['ben-ws']);
    expect(await names(adminCookie)).toEqual(['default-workspace', 'anna-ws', 'ben-ws']);
    expect((await listWorkspacesRoute(request('GET', '/api/workspaces'))).status).toBe(401);
  });

  it('ends access at the next request when the person is disabled', async () => {
    await mutateAccounts(current => ({
      ...current!, users: current!.users.map(person => person.name === 'anna' ? { ...person, disabled: true, generation: 2 } : person),
    }));
    try {
      expect((await wrapped(request('GET', select('/api/flow', 'anna-ws'), { cookie: annaCookie }))).status).toBe(401);
    } finally {
      await mutateAccounts(current => ({
        ...current!, users: current!.users.map(person => person.name === 'anna' ? { ...person, disabled: false } : person),
      }));
    }
    expect((await wrapped(request('GET', select('/api/flow', 'anna-ws'), { cookie: annaCookie }))).status).toBe(401);
  });
});
