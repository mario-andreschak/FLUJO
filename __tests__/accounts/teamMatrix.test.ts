jest.mock('@/backend/services/workspace/layoutReadiness', () => ({
  waitForWorkspaceLayoutReady: async () => undefined,
  getWorkspaceLayoutStatus: () => 'ready',
}));
jest.mock('@/utils/workspace', () => {
  const actual = jest.requireActual('@/utils/workspace');
  return {
    ...actual,
    ensureWorkspaceDirs: async () => undefined,
    // A real workspace copies the bundled MCP servers, which are not built in unit tests.
    createWorkspace: async (name: string) => {
      await jest.requireActual('node:fs/promises').mkdir(actual.getWorkspaceDir(name), { recursive: true });
      return { name };
    },
  };
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { DELETE as deleteTeamRoute, PATCH as patchTeamRoute, POST as postTeamRoute, GET as getTeamsRoute } from '@/app/api/accounts/teams/route';
import { PUT as assignWorkspaceRoute } from '@/app/api/accounts/users/route';
import { POST as createWorkspaceRoute } from '@/app/api/workspaces/route';
import { decideBackgroundAccess, decideWorkspaceAccess, workspaceActions } from '@/backend/services/accounts/access';
import { currentAccountPrincipal } from '@/backend/services/accounts/context';
import { createAccountSession } from '@/backend/services/accounts/sessions';
import { loadEnabledAccounts, mutateAccounts } from '@/backend/services/accounts/store';
import { hashPassword } from '@/backend/services/accounts/passwords';
import { getCurrentWorkspace } from '@/utils/workspace';
import { WORKSPACE_ACTIONS, type AccountUser, type AccountsFile, type WorkspaceAction } from '@/shared/types/accounts';
import { TEST_LOG_N, useTemporaryDataDir } from './helpers';

/**
 * Three-role matrix for teams (#575, step 575-5): a team owner, a member
 * (editor) and a viewer, against people outside the team (never in it,
 * invited but not accepted, removed), for read, edit, run and admin. It runs
 * the pure rules and the real proxy and workspace wrapper, then changes the
 * team (removal, role changes) and tries the obvious ways to escalate.
 */

const HOST = 'localhost:4200';
const now = Date.now();
const ids = {
  admin: 'u_admin00000000000000', anna: 'u_anna000000000000000', ben: 'u_ben0000000000000000',
  vera: 'u_vera00000000000000', cleo: 'u_cleo00000000000000', ivan: 'u_ivan00000000000000',
  dora: 'u_dora00000000000000', sales: 't_sales0000000000000',
} as const;
type Person = keyof Omit<typeof ids, 'sales'>;

const user = (id: string, name: string, hash: string, role: 'admin' | 'member' = 'member'): AccountUser => ({
  id, name, displayName: name[0].toUpperCase() + name.slice(1), passwordHash: hash, role, hostAccess: false,
  disabled: false, generation: 1, createdAt: now - 1000,
});

function team(members: AccountsFile['teams'][number]['members']): AccountsFile['teams'][number] {
  return { id: ids.sales, name: 'Sales', generation: 1, createdAt: now, members };
}

const MEMBERS: AccountsFile['teams'][number]['members'] = [
  { userId: ids.anna, role: 'owner', state: 'member' },
  { userId: ids.ben, role: 'member', state: 'member' },
  { userId: ids.vera, role: 'viewer', state: 'member' },
  { userId: ids.ivan, role: 'member', state: 'invited' },
  { userId: ids.dora, role: 'owner', state: 'removed' },
];

/** What each person may do in the team workspace. `null`: it looks like the workspace does not exist. */
const EXPECTED: Readonly<Record<Person, Readonly<Record<WorkspaceAction, 'allow' | 'view-only' | 'workspace-admin-required' | 'not-found'>>>> = {
  admin: { read: 'allow', edit: 'allow', run: 'allow', admin: 'allow' },
  anna: { read: 'allow', edit: 'allow', run: 'allow', admin: 'allow' },
  ben: { read: 'allow', edit: 'allow', run: 'allow', admin: 'workspace-admin-required' },
  vera: { read: 'allow', edit: 'view-only', run: 'view-only', admin: 'workspace-admin-required' },
  cleo: { read: 'not-found', edit: 'not-found', run: 'not-found', admin: 'not-found' },
  ivan: { read: 'not-found', edit: 'not-found', run: 'not-found', admin: 'not-found' },
  dora: { read: 'not-found', edit: 'not-found', run: 'not-found', admin: 'not-found' },
};

/** Real routes for each action; object ids are guesses that do not exist. */
const ROUTES: Readonly<Record<WorkspaceAction, ReadonlyArray<readonly [method: string, route: string]>>> = {
  read: [['GET', '/api/flow'], ['GET', '/api/flow/guessed-flow-id'], ['GET', '/v1/chat/conversations/guessed-chat'], ['GET', '/api/history?kind=flow&id=f1']],
  edit: [['POST', '/api/flow'], ['PUT', '/api/model/guessed-model'], ['DELETE', '/api/flow/guessed-flow-id'], ['POST', '/api/edit-locks']],
  run: [['POST', '/v1/chat/completions'], ['POST', '/api/planned-executions/p1/run'], ['POST', '/api/mcp/servers/bash/tools/run']],
  admin: [['POST', '/api/backup'], ['POST', '/api/credential-transfer'], ['POST', '/api/restore']],
};

const DENIAL_CODE = { 'view-only': 'TEAM_VIEW_ONLY', 'workspace-admin-required': 'WORKSPACE_ADMIN_REQUIRED' } as const;

describe('three-role team matrix', () => {
  let restore: () => Promise<void>;
  let dir: string;
  let people: Record<Person, AccountUser>;
  const cookies = {} as Record<Person, string>;

  beforeAll(async () => {
    ({ dir, restore } = await useTemporaryDataDir());
    for (const name of ['default-workspace', 'sales-ws', 'cleo-ws']) await fs.mkdir(path.join(dir, 'workspaces', name), { recursive: true });
    const hash = await hashPassword('a long enough test passphrase', TEST_LOG_N);
    people = {
      admin: user(ids.admin, 'admin', hash, 'admin'), anna: user(ids.anna, 'anna', hash), ben: user(ids.ben, 'ben', hash),
      vera: user(ids.vera, 'vera', hash), cleo: user(ids.cleo, 'cleo', hash), ivan: user(ids.ivan, 'ivan', hash),
      dora: user(ids.dora, 'dora', hash),
    };
    for (const person of Object.keys(people) as Person[]) cookies[person] = '';
  });
  afterAll(async () => restore());

  beforeEach(async () => {
    await mutateAccounts(() => ({
      schemaVersion: 1, enabled: true, revision: 0, users: Object.values(people), apiTokens: [],
      teams: [team(MEMBERS)],
      workspaces: {
        'default-workspace': { ownerType: 'user', ownerId: ids.admin, assignedAt: now },
        'sales-ws': { ownerType: 'team', ownerId: ids.sales, assignedAt: now },
        'cleo-ws': { ownerType: 'user', ownerId: ids.cleo, assignedAt: now },
      },
    }));
    for (const person of Object.keys(people) as Person[]) {
      cookies[person] = `flujo-session=${(await createAccountSession(people[person])).token}`;
    }
  });

  const handler = jest.fn(async () => Response.json({ workspace: getCurrentWorkspace(), userId: currentAccountPrincipal()?.userId ?? null }));
  const wrapped = withWorkspaceRoute(handler as never) as unknown as (request: Request) => Promise<Response>;
  beforeEach(() => handler.mockClear());

  function request(method: string, route: string, person: Person, workspace = 'sales-ws', headers: Record<string, string> = {}) {
    const url = `http://${HOST}${route}${route.includes('?') ? '&' : '?'}workspace=${workspace}`;
    return new NextRequest(url, { method, headers: { host: HOST, cookie: cookies[person], ...headers } });
  }

  async function expectOutcome(response: Response, outcome: string, label: string) {
    const body = await response.json().catch(() => null);
    if (outcome === 'allow') {
      expect([label, response.status]).toEqual([label, 200]);
    } else if (outcome === 'not-found') {
      expect([label, response.status, body]).toEqual([label, 404, { error: 'Unknown workspace: sales-ws' }]);
    } else {
      expect([label, response.status, body?.code]).toEqual([label, 403, DENIAL_CODE[outcome as keyof typeof DENIAL_CODE]]);
    }
  }

  it('the pure rules give each role exactly its actions', async () => {
    const accounts = (await loadEnabledAccounts())!;
    for (const person of Object.keys(EXPECTED) as Person[]) {
      for (const action of WORKSPACE_ACTIONS) {
        const decision = decideWorkspaceAccess(accounts, { kind: 'session', userId: ids[person], sessionId: 's_xxxxxxxxxxxxxxxx', generation: 1 },
          'sales-ws', action, Date.now());
        const outcome = decision.allowed ? 'allow' : decision.denial;
        expect([person, action, outcome]).toEqual([person, action, EXPECTED[person][action]]);
      }
    }
    expect(workspaceActions(accounts, people.vera, 'sales-ws')).toEqual(['read']);
  });

  it.each(WORKSPACE_ACTIONS)('%s: every role gets its answer from the proxy and the workspace wrapper', async action => {
    for (const person of Object.keys(EXPECTED) as Person[]) {
      for (const [method, route] of ROUTES[action]) {
        const label = `${person} ${method} ${route}`;
        const outcome = EXPECTED[person][action];
        const viaHeader = new NextRequest(`http://${HOST}${route}`, { method, headers: { host: HOST, cookie: cookies[person], 'x-flujo-workspace': 'sales-ws' } });
        for (const candidate of [request(method, route, person), viaHeader]) {
          const fromProxy = await proxy(candidate);
          if (outcome === 'allow') expect([label, fromProxy.status]).toEqual([label, 200]);
          else await expectOutcome(fromProxy, outcome, `${label} (proxy)`);
          handler.mockClear();
          await expectOutcome(await wrapped(candidate.clone() as Request), outcome, `${label} (wrapper)`);
          expect([label, handler.mock.calls.length]).toEqual([label, outcome === 'allow' ? 1 : 0]);
        }
      }
    }
  });

  it('removing a member cuts access at the next request; a new role counts at once', async () => {
    const { changeMember } = await import('@/backend/services/accounts/teams');
    expect((await wrapped(request('POST', '/api/flow', 'ben'))).status).toBe(200);
    const before = (await loadEnabledAccounts())!.teams[0].generation;
    await changeMember(ids.sales, { userId: ids.ben, remove: true }, people.anna);
    await expectOutcome(await wrapped(request('GET', '/api/flow', 'ben')), 'not-found', 'removed ben');
    await changeMember(ids.sales, { userId: ids.vera, role: 'member' }, people.anna);
    expect((await wrapped(request('POST', '/api/flow', 'vera'))).status).toBe(200);
    await changeMember(ids.sales, { userId: ids.vera, role: 'viewer' }, people.anna);
    await expectOutcome(await wrapped(request('POST', '/api/flow', 'vera')), 'view-only', 'vera viewer again');
    // Every removal and role change raised the generation, which ends edit leases.
    expect((await loadEnabledAccounts())!.teams[0].generation).toBe(before + 3);
  });

  it('closes an open live-update stream when the member is removed', async () => {
    const { changeMember } = await import('@/backend/services/accounts/teams');
    const streaming = withWorkspaceRoute((async () => new Response(new ReadableStream({ start() { /* stays open */ } }), {
      headers: { 'content-type': 'text/event-stream' },
    })) as never) as unknown as (request: Request) => Promise<Response>;
    const response = await streaming(request('GET', '/v1/chat/events', 'ben'));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const ended = reader.read();
    await changeMember(ids.sales, { userId: ids.ben, remove: true }, people.anna);
    await expect(ended).rejects.toThrow(/authorization ended/i);
  }, 10_000);

  describe('escalation attempts', () => {
    const call = (handlerFn: (request: Request) => Promise<Response>, method: string, person: Person, body: unknown) =>
      handlerFn(new Request(`http://${HOST}/api/accounts/teams`, {
        method, headers: { host: HOST, cookie: cookies[person], 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));

    it('a member or viewer cannot change the team, and outsiders cannot even see it', async () => {
      for (const person of ['ben', 'vera'] as const) {
        const self = await call(patchTeamRoute, 'PATCH', person, { teamId: ids.sales, member: { userId: ids[person], role: 'owner' } });
        expect([person, self.status]).toEqual([person, 403]);
      }
      for (const person of ['cleo', 'dora'] as const) {
        const guessed = await call(patchTeamRoute, 'PATCH', person, { teamId: ids.sales, member: { userId: ids[person], role: 'owner' } });
        expect([person, guessed.status, (await guessed.json()).error]).toEqual([person, 404, 'No such team.']);
      }
      const accounts = (await loadEnabledAccounts())!;
      expect(accounts.teams[0].members.find(member => member.userId === ids.ben)?.role).toBe('member');
    });

    it('an invited person can only answer their own invitation', async () => {
      const notMine = await call(patchTeamRoute, 'PATCH', 'cleo', { teamId: ids.sales, answer: 'accept' });
      expect(notMine.status).toBe(404);
      await expectOutcome(await wrapped(request('GET', '/api/flow', 'ivan')), 'not-found', 'ivan before accepting');
      const accepted = await call(patchTeamRoute, 'PATCH', 'ivan', { teamId: ids.sales, answer: 'accept' });
      expect(accepted.status).toBe(200);
      expect((await wrapped(request('POST', '/api/flow', 'ivan'))).status).toBe(200);
    });

    it('only admins make and delete teams; only team owners and admins make team workspaces', async () => {
      expect((await call(postTeamRoute, 'POST', 'anna', { name: 'Shadow' })).status).toBe(403);
      expect((await call(deleteTeamRoute, 'DELETE', 'anna', { teamId: ids.sales })).status).toBe(403);
      const refused = await call(deleteTeamRoute, 'DELETE', 'admin', { teamId: ids.sales });
      expect([refused.status, (await refused.json()).error]).toEqual([409, expect.stringContaining('still owns sales-ws')]);
      const create = (person: Person, name: string) => createWorkspaceRoute(new Request(`http://${HOST}/api/workspaces`, {
        method: 'POST', headers: { host: HOST, cookie: cookies[person], 'content-type': 'application/json' },
        body: JSON.stringify({ name, teamId: ids.sales }),
      }));
      expect((await create('ben', 'ben-team-ws')).status).toBe(404);
      expect((await create('vera', 'vera-team-ws')).status).toBe(404);
      expect((await create('cleo', 'cleo-team-ws')).status).toBe(404);
      await expect(fs.stat(path.join(dir, 'workspaces', 'ben-team-ws'))).rejects.toMatchObject({ code: 'ENOENT' });
      const made = await create('anna', 'sales-two');
      expect(made.status).toBe(201);
      expect((await loadEnabledAccounts())!.workspaces['sales-two']).toMatchObject({ ownerType: 'team', ownerId: ids.sales });
      expect((await wrapped(request('POST', '/api/flow', 'ben', 'sales-two'))).status).toBe(200);
      await expectOutcome(await wrapped(request('POST', '/api/flow', 'vera', 'sales-two')), 'view-only', 'vera in sales-two');
    });

    it('nobody but an admin can give a workspace to a team or a person', async () => {
      const assign = (person: Person) => assignWorkspaceRoute(new Request(`http://${HOST}/api/accounts/users`, {
        method: 'PUT', headers: { host: HOST, cookie: cookies[person], 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: 'cleo-ws', ownerId: ids.sales, ownerType: 'team' }),
      }));
      expect((await assign('anna')).status).toBe(403);
      expect((await assign('cleo')).status).toBe(403);
      expect((await assign('admin')).status).toBe(200);
      expect((await wrapped(request('GET', '/api/flow', 'ben', 'cleo-ws'))).status).toBe(200);
    });

    it('people who manage no team see no list of other people', async () => {
      const list = async (person: Person) => (await (await getTeamsRoute(new Request(`http://${HOST}/api/accounts/teams`, {
        headers: { host: HOST, cookie: cookies[person] },
      }))).json());
      expect((await list('ben')).people).toEqual([]);
      expect((await list('cleo')).teams).toEqual([]);
      expect((await list('anna')).people.length).toBeGreaterThan(0);
      const forVera = await list('vera');
      expect(forVera.teams[0]).toMatchObject({ myRole: 'viewer', mayManage: false });
      expect(JSON.stringify(forVera)).not.toMatch(/passwordHash|scrypt/);
    });
  });

  describe('background work in a team workspace', () => {
    it('runs while someone who may run things is active, and pauses for a starter who lost access', async () => {
      const accounts = (await loadEnabledAccounts())!;
      expect(decideBackgroundAccess(accounts, 'sales-ws', { kind: 'background', startedBy: ids.ben }, Date.now())).toMatchObject({ allowed: true });
      expect(decideBackgroundAccess(accounts, 'sales-ws', { kind: 'background', startedBy: ids.vera }, Date.now()))
        .toMatchObject({ allowed: false, denial: 'starter-lost-access' });
      const viewersOnly = { ...accounts, teams: [team([{ userId: ids.vera, role: 'viewer', state: 'member' }])] };
      expect(decideBackgroundAccess(viewersOnly, 'sales-ws', { kind: 'background' }, Date.now()))
        .toMatchObject({ allowed: false, denial: 'owner-inactive' });
    });
  });
});
