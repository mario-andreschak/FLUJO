jest.mock('@/backend/services/workspace/layoutReadiness', () => ({
  waitForWorkspaceLayoutReady: async () => undefined,
  getWorkspaceLayoutStatus: () => 'ready',
}));
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  ensureWorkspaceDirs: async () => undefined,
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/backend/services/sharedItems/teamCopy', () => ({
  ...jest.requireActual('@/backend/services/sharedItems/teamCopy'),
  copySharedItem: jest.fn(async ({ kind, id, targetWorkspace }: { kind: string; id: string; targetWorkspace: string }) => ({
    copied: { kind, id, name: id }, targetWorkspace, missingValues: [], missingDependencies: [],
  })),
}));

import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/team-copy/route';
import { createAccountSession } from '@/backend/services/accounts/sessions';
import { mutateAccounts } from '@/backend/services/accounts/store';
import { hashPassword } from '@/backend/services/accounts/passwords';
import { copySharedItem } from '@/backend/services/sharedItems/teamCopy';
import type { AccountUser } from '@/shared/types/accounts';
import { TEST_LOG_N, useTemporaryDataDir } from '../accounts/helpers';

/**
 * The copy route (#575): a person copies only into a workspace they may
 * change. Any other target, whether it belongs to someone else, to a team
 * where they only look, or does not exist, gets the same "Unknown workspace"
 * answer, and nothing is copied. With multi-user mode off the route does
 * nothing.
 */

const HOST = 'localhost:4200';
const now = Date.now();
const ids = {
  admin: 'u_admin00000000000000', anna: 'u_anna000000000000000', ben: 'u_ben0000000000000000', cleo: 'u_cleo00000000000000',
  sales: 't_sales0000000000000',
} as const;
const user = (id: string, name: string, role: 'admin' | 'member', passwordHash: string): AccountUser => ({
  id, name, displayName: name, passwordHash, role, hostAccess: false, disabled: false, generation: 1, createdAt: now - 1000,
});

function request(method: string, workspace: string, cookie?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://${HOST}/api/team-copy?workspace=${workspace}`, {
    method,
    headers: { host: HOST, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('copy route with multi-user mode off', () => {
  let restore: () => Promise<void>;
  beforeAll(async () => {
    let dir: string;
    ({ dir, restore } = await useTemporaryDataDir());
    for (const name of ['default-workspace', 'other']) await fs.mkdir(path.join(dir, 'workspaces', name), { recursive: true });
  });
  afterAll(async () => restore());

  it('offers nothing and copies nothing', async () => {
    const listed = await GET(request('GET', 'default-workspace'));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ enabled: false });
    const copied = await POST(request('POST', 'default-workspace', undefined, { kind: 'flow', id: 'f1', targetWorkspace: 'other' }));
    expect(copied.status).toBe(409);
    expect(await copied.json()).toMatchObject({ code: 'MULTI_USER_OFF' });
    expect(copySharedItem).not.toHaveBeenCalled();
  });
});

describe('copy route with multi-user mode on', () => {
  let restore: () => Promise<void>;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    let dir: string;
    ({ dir, restore } = await useTemporaryDataDir());
    for (const name of ['default-workspace', 'anna-ws', 'ben-ws', 'cleo-ws', 'sales-ws']) {
      await fs.mkdir(path.join(dir, 'workspaces', name), { recursive: true });
    }
    const hash = await hashPassword('a long enough test passphrase', TEST_LOG_N);
    const people = [user(ids.admin, 'admin', 'admin', hash), user(ids.anna, 'anna', 'member', hash),
      user(ids.ben, 'ben', 'member', hash), user(ids.cleo, 'cleo', 'member', hash)];
    await mutateAccounts(() => ({
      schemaVersion: 1, enabled: true, revision: 0, users: people,
      teams: [{ id: ids.sales, name: 'Sales', generation: 1, createdAt: now, members: [
        { userId: ids.anna, role: 'owner', state: 'member' },
        { userId: ids.ben, role: 'member', state: 'member' },
        { userId: ids.cleo, role: 'viewer', state: 'member' },
      ] }],
      workspaces: {
        'default-workspace': { ownerType: 'user', ownerId: ids.admin, assignedAt: now },
        'anna-ws': { ownerType: 'user', ownerId: ids.anna, assignedAt: now },
        'ben-ws': { ownerType: 'user', ownerId: ids.ben, assignedAt: now },
        'cleo-ws': { ownerType: 'user', ownerId: ids.cleo, assignedAt: now },
        'sales-ws': { ownerType: 'team', ownerId: ids.sales, assignedAt: now },
      },
      apiTokens: [],
    }));
    for (const person of people) cookies[person.name] = `flujo-session=${(await createAccountSession(person)).token}`;
  });
  afterAll(async () => restore());
  beforeEach(() => jest.mocked(copySharedItem).mockClear());

  const targets = async (person: string, from: string) => {
    const response = await GET(request('GET', from, cookies[person]));
    expect(response.status).toBe(200);
    const body = await response.json() as { enabled: boolean; targets: Array<{ workspace: string; teamName?: string }> };
    expect(body.enabled).toBe(true);
    return body.targets;
  };

  it('lists only the other workspaces the person may change', async () => {
    expect(await targets('anna', 'anna-ws')).toEqual([{ workspace: 'sales-ws', ownerType: 'team', teamName: 'Sales', mine: false }]);
    expect((await targets('ben', 'sales-ws')).map(item => item.workspace)).toEqual(['ben-ws']);
    expect(await targets('cleo', 'cleo-ws')).toEqual([]);
  });

  it('copies into a team workspace for a team member', async () => {
    const response = await POST(request('POST', 'ben-ws', cookies.ben, { kind: 'flow', id: 'f1', targetWorkspace: 'sales-ws' }));
    expect(response.status).toBe(201);
    expect(copySharedItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'flow', id: 'f1', targetWorkspace: 'sales-ws' }));
  });

  it.each([
    ['someone else\'s workspace', 'anna', 'anna-ws', 'ben-ws'],
    ['a team workspace where the person only looks', 'cleo', 'cleo-ws', 'sales-ws'],
    ['a workspace that does not exist', 'anna', 'anna-ws', 'ghost-ws'],
  ])('answers %s exactly like an unknown workspace', async (_case, person, from, target) => {
    const response = await POST(request('POST', from, cookies[person], { kind: 'model', id: 'm1', targetWorkspace: target }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: `Unknown workspace: ${target}` });
    expect(copySharedItem).not.toHaveBeenCalled();
  });

  it('refuses a request that does not say what to copy', async () => {
    for (const body of [{ kind: 'secret', id: 'x', targetWorkspace: 'sales-ws' }, { kind: 'flow', targetWorkspace: 'sales-ws' },
      { kind: 'flow', id: 'f1', targetWorkspace: '../sales-ws' }]) {
      expect((await POST(request('POST', 'anna-ws', cookies.anna, body))).status).toBe(400);
    }
    expect(copySharedItem).not.toHaveBeenCalled();
  });

  it('needs a signed-in person', async () => {
    expect((await POST(request('POST', 'anna-ws', undefined, { kind: 'flow', id: 'f1', targetWorkspace: 'sales-ws' }))).status).toBe(401);
    expect(copySharedItem).not.toHaveBeenCalled();
  });
});
