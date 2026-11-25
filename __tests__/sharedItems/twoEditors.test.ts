jest.mock('@/backend/services/workspace/layoutReadiness', () => ({
  waitForWorkspaceLayoutReady: async () => undefined,
  getWorkspaceLayoutStatus: () => 'ready',
}));
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  ensureWorkspaceDirs: async () => undefined,
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/backend/services/enduringAgents', () => ({ listPersonas: async () => [] }));

/** An in-memory flow store per workspace that stamps `updatedAt` and honours `expectedUpdatedAt`, like the real one. */
const flows = new Map<string, Record<string, unknown>>();
let clock = 1_800_000_000_000;
jest.mock('@/backend/services/flow', () => {
  const { getCurrentWorkspace } = jest.requireActual('@/utils/workspace');
  const key = (id: string) => `${getCurrentWorkspace()}/${id}`;
  return {
    flowService: {
      getFlow: async (id: string) => structuredClone(flows.get(key(id)) ?? null),
      saveFlow: async (flow: Record<string, unknown>, options: { expectedUpdatedAt?: number } = {}) => {
        const previous = flows.get(key(flow.id as string));
        if (options.expectedUpdatedAt !== undefined && previous?.updatedAt !== options.expectedUpdatedAt) {
          return { success: false, error: 'Flow changed since inspection.' };
        }
        flow.updatedAt = ++clock;
        flows.set(key(flow.id as string), structuredClone(flow));
        return { success: true };
      },
      deleteFlow: async (id: string) => ({ success: flows.delete(key(id)) }),
    },
  };
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PUT } from '@/app/api/flow/[id]/route';
import { createAccountSession } from '@/backend/services/accounts/sessions';
import { changeMember } from '@/backend/services/accounts/teams';
import { mutateAccounts, resetAccountsStoreCache } from '@/backend/services/accounts/store';
import { hashPassword } from '@/backend/services/accounts/passwords';
import { listHistory } from '@/backend/services/sharedItems/history';
import { runWithWorkspace } from '@/utils/workspace';
import type { AccountUser } from '@/shared/types/accounts';
import { TEST_LOG_N, snapshotTree, useTemporaryDataDir } from '../accounts/helpers';

/**
 * Two people edit the same flow in a team workspace (#575, step 575-2): one
 * save wins, the other gets a visible conflict instead of silently replacing
 * it; saving over it on purpose works and both versions stay in the history.
 * With multi-user mode off nothing of this happens.
 */

const HOST = 'localhost:4200';
const now = Date.now();
const user = (id: string, name: string, displayName: string, hash: string): AccountUser => ({
  id, name, displayName, passwordHash: hash, role: 'member', hostAccess: false, disabled: false, generation: 1, createdAt: now - 1000,
});
const ids = { admin: 'u_admin00000000000000', anna: 'u_anna000000000000000', ben: 'u_ben0000000000000000', vera: 'u_vera00000000000000', team: 't_sales0000000000000' };

describe('two editors save the same flow', () => {
  let restore: () => Promise<void>;
  let dir: string;
  const cookies: Record<string, string> = {};
  let people: Record<string, AccountUser>;

  beforeAll(async () => {
    ({ dir, restore } = await useTemporaryDataDir());
    for (const name of ['default-workspace', 'sales-ws']) await fs.mkdir(path.join(dir, 'workspaces', name), { recursive: true });
    const hash = await hashPassword('a long enough test passphrase', TEST_LOG_N);
    people = {
      admin: { ...user(ids.admin, 'admin', 'Admin', hash), role: 'admin' },
      anna: user(ids.anna, 'anna', 'Anna', hash),
      ben: user(ids.ben, 'ben', 'Ben', hash),
      vera: user(ids.vera, 'vera', 'Vera', hash),
    };
    await mutateAccounts(() => ({
      schemaVersion: 1, enabled: true, revision: 0, users: Object.values(people), apiTokens: [],
      teams: [{ id: ids.team, name: 'Sales', generation: 1, createdAt: now, members: [
        { userId: ids.anna, role: 'owner', state: 'member' },
        { userId: ids.ben, role: 'member', state: 'member' },
        { userId: ids.vera, role: 'viewer', state: 'member' },
      ] }],
      workspaces: {
        'default-workspace': { ownerType: 'user', ownerId: ids.admin, assignedAt: now },
        'sales-ws': { ownerType: 'team', ownerId: ids.team, assignedAt: now },
      },
    }));
    for (const [name, person] of Object.entries(people)) cookies[name] = `flujo-session=${(await createAccountSession(person)).token}`;
  });
  afterAll(async () => restore());
  beforeEach(() => {
    flows.clear();
    flows.set('sales-ws/f1', { id: 'f1', name: 'Offer flow', nodes: [], edges: [], updatedAt: 1000 });
  });

  function save(person: string, body: Record<string, unknown>, base?: string) {
    const request = new NextRequest(`http://${HOST}/api/flow/f1?workspace=sales-ws`, {
      method: 'PUT',
      headers: { host: HOST, 'content-type': 'application/json', cookie: cookies[person], ...(base ? { 'x-flujo-base-revision': base } : {}) },
      body: JSON.stringify({ id: 'f1', nodes: [], edges: [], ...body }),
    });
    return PUT(request, { params: Promise.resolve({ id: 'f1' }) });
  }
  const history = () => runWithWorkspace('sales-ws', () => listHistory('flow', 'f1'));

  it('gives one success and one visible conflict, never a silent overwrite', async () => {
    const first = await save('anna', { name: 'Offer flow (Anna)' }, 'f1000');
    expect(first.status).toBe(200);
    const second = await save('ben', { name: 'Offer flow (Ben)' }, 'f1000');
    expect(second.status).toBe(409);
    const conflict = await second.json();
    expect(conflict).toMatchObject({
      code: 'EDIT_CONFLICT', kind: 'flow', itemId: 'f1', changedBy: { name: 'Anna' },
      current: { name: 'Offer flow (Anna)' },
    });
    expect(conflict.error).toMatch(/Anna saved this flow while you were editing it/);
    expect(flows.get('sales-ws/f1')?.name).toBe('Offer flow (Anna)');

    // Ben looks at both and decides to save his over Anna's on purpose.
    const mine = await save('ben', { name: 'Offer flow (Ben)' }, conflict.currentRevision);
    expect(mine.status).toBe(200);
    expect(flows.get('sales-ws/f1')?.name).toBe('Offer flow (Ben)');
    // Nothing is lost: Anna's version is in the history, with who did what.
    const entries = await history();
    expect(entries.map(entry => [entry.actor.name, entry.action, (entry.snapshot as { name: string }).name])).toEqual([
      ['Anna', 'saved', 'Offer flow (Anna)'],
      ['Ben', 'saved', 'Offer flow (Ben)'],
    ]);
  });

  it('lets a person save again over their own earlier save, even from an older base', async () => {
    expect((await save('anna', { name: 'one' }, 'f1000')).status).toBe(200);
    expect((await save('anna', { name: 'two' }, 'f1000')).status).toBe(200);
    expect(flows.get('sales-ws/f1')?.name).toBe('two');
  });

  it('refuses a viewer before anything is saved', async () => {
    const response = await save('vera', { name: 'viewer edit' }, 'f1000');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'TEAM_VIEW_ONLY' });
    expect(flows.get('sales-ws/f1')?.name).toBe('Offer flow');
  });

  it('cuts off a removed member at the next request', async () => {
    await changeMember(ids.team, { userId: ids.ben, remove: true }, { ...people.anna });
    const response = await save('ben', { name: 'after removal' }, 'f1000');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Unknown workspace: sales-ws' });
    await changeMember(ids.team, { userId: ids.ben, role: 'member' }, { ...people.anna });
  });

  it('does none of this with multi-user mode off: stale saves go through and no history file appears', async () => {
    await mutateAccounts(current => ({ ...current!, enabled: false }));
    resetAccountsStoreCache();
    const historyDir = path.join(dir, 'workspaces', 'sales-ws', 'db', 'history');
    const before = await snapshotTree(historyDir);
    const request = (name: string) => new NextRequest(`http://${HOST}/api/flow/f1?workspace=sales-ws`, {
      method: 'PUT', headers: { host: HOST, 'content-type': 'application/json', 'x-flujo-base-revision': 'f1000' },
      body: JSON.stringify({ id: 'f1', name, nodes: [], edges: [] }),
    });
    expect((await PUT(request('first'), { params: Promise.resolve({ id: 'f1' }) })).status).toBe(200);
    expect((await PUT(request('second'), { params: Promise.resolve({ id: 'f1' }) })).status).toBe(200);
    expect(flows.get('sales-ws/f1')?.name).toBe('second');
    // History files stay byte for byte as they were.
    expect(await snapshotTree(historyDir)).toEqual(before);
    await mutateAccounts(current => ({ ...current!, enabled: true }));
  });
});
