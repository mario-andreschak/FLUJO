/**
 * Multi-user mode, step 574-5: a turned-off owner's automatic runs pause and
 * resume by themselves, also after a restart.
 */
import { SchedulerService } from '@/backend/services/scheduler';
import { backgroundWorkPause } from '@/backend/services/accounts/background';
import { mutateAccounts, resetAccountsStoreCache } from '@/backend/services/accounts/store';
import type { AccountsFile, AccountUser } from '@/shared/types/accounts';
import { passwordHash } from './fixtures';
import { useTemporaryDataDir } from './helpers';

const store = new Map<string, unknown>();
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: jest.fn(async (key: string, defaultValue: unknown) =>
    store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : defaultValue),
  saveItem: jest.fn(async (key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); }),
  clearItem: jest.fn(async (key: string) => { store.delete(key); }),
}));
const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: (...args: unknown[]) => runFlowMock(...args) }));
jest.mock('@/utils/encryption/secure', () => ({ isEncryptionLocked: jest.fn(async () => false) }));
jest.mock('@/backend/services/statistics', () => ({
  classifySchedulerSkip: jest.fn(() => 'other'),
  createStatisticsEvent: jest.fn((event: Record<string, unknown>) => event),
  recordStatisticsEvent: jest.fn(),
}));

const now = Date.now();
const person = (id: string, name: string, extra: Partial<AccountUser> = {}): AccountUser => ({
  id, name, displayName: name, passwordHash: passwordHash(), role: 'member', hostAccess: false, disabled: false,
  generation: 1, createdAt: now - 1000, ...extra,
});
const ids = { admin: 'u_admin00000000000000', anna: 'u_anna000000000000000', ben: 'u_ben0000000000000000' };

function accounts(change: Partial<AccountsFile> = {}): AccountsFile {
  return {
    schemaVersion: 1, enabled: true, revision: 0, teams: [], apiTokens: [],
    users: [person(ids.admin, 'admin', { role: 'admin' }), person(ids.anna, 'anna'), person(ids.ben, 'ben', { hostAccess: true })],
    workspaces: {
      'default-workspace': { ownerType: 'user', ownerId: ids.anna, assignedAt: now },
      'admin-ws': { ownerType: 'user', ownerId: ids.admin, assignedAt: now },
      'ben-ws': { ownerType: 'user', ownerId: ids.ben, assignedAt: now },
    },
    ...change,
  };
}

const setAnnaDisabled = (disabled: boolean) => mutateAccounts(current => ({
  ...current!, users: current!.users.map(user => user.id === ids.anna ? { ...user, disabled } : user),
}));

describe('a turned-off owner\'s automatic runs', () => {
  let restore: () => Promise<void>;
  beforeEach(async () => {
    ({ restore } = await useTemporaryDataDir());
    store.clear();
    runFlowMock.mockReset().mockResolvedValue({
      status: 'completed', outputText: 'done', messages: [], conversationId: 'c', sharedState: {},
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0, byNode: {} },
    });
  });
  afterEach(async () => restore());

  const schedule = { name: 'Daily digest', enabled: true, flowId: 'flow-1', prompt: 'Summarise', trigger: { type: 'schedule' as const, cron: '0 9 * * *' } };

  it('never pause while multi-user mode is off', async () => {
    expect(await backgroundWorkPause('default-workspace')).toEqual({ paused: false });
    const scheduler = new SchedulerService();
    const { execution } = await scheduler.create(schedule);
    expect((await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' })).status).not.toBe('skipped');
    expect(runFlowMock).toHaveBeenCalledTimes(1);
  });

  it('pause while the owner is turned off and resume by themselves, also after a restart', async () => {
    await mutateAccounts(() => accounts());
    let scheduler = new SchedulerService();
    const { execution } = await scheduler.create(schedule);

    expect((await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' })).status).not.toBe('skipped');
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    await setAnnaDisabled(true);
    const paused = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });
    expect(paused).toMatchObject({ status: 'skipped', error: expect.stringMatching(/^Paused: the owner of this workspace/) });
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    // A restart forgets nothing that matters: the pause is not stored anywhere.
    resetAccountsStoreCache();
    scheduler = new SchedulerService();
    expect((await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' })).status).toBe('skipped');
    expect(runFlowMock).toHaveBeenCalledTimes(1);

    await setAnnaDisabled(false);
    expect((await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' })).status).not.toBe('skipped');
    expect(runFlowMock).toHaveBeenCalledTimes(2);
  });

  it('let an admin still run one by hand while the owner is turned off', async () => {
    await mutateAccounts(() => accounts());
    const scheduler = new SchedulerService();
    const { execution } = await scheduler.create(schedule);
    await setAnnaDisabled(true);
    const { record } = await scheduler.runNow(execution!.id);
    expect(record?.status).not.toBe('skipped');
    expect(runFlowMock).toHaveBeenCalledTimes(1);
  });

  it('pause while the person who set it up may not run things in a team workspace, and resume by themselves (#575)', async () => {
    const team = { id: 't_sales0000000000000', name: 'Sales', generation: 1, createdAt: now, members: [
      { userId: ids.anna, role: 'owner' as const, state: 'member' as const },
      { userId: ids.ben, role: 'member' as const, state: 'member' as const },
    ] };
    await mutateAccounts(() => accounts({
      teams: [team],
      workspaces: { 'default-workspace': { ownerType: 'team', ownerId: team.id, assignedAt: now } },
    }));
    const { withAutomationStarter } = await import('@/backend/services/accounts/automationStarter');
    const { runWithAccountPrincipal } = await import('@/backend/services/accounts/context');
    const ben = { kind: 'session' as const, userId: ids.ben, sessionId: 's_ben_session_xxxxx', generation: 1 };
    // A body cannot name someone else; the signed-in person is recorded.
    const body = runWithAccountPrincipal(ben, () => withAutomationStarter({ ...schedule, startedBy: ids.anna }));
    expect(body.startedBy).toBe(ids.ben);
    expect(withAutomationStarter({ ...schedule, startedBy: ids.anna })).not.toHaveProperty('startedBy');

    const scheduler = new SchedulerService();
    const { execution } = await scheduler.create(body);
    expect(execution?.startedBy).toBe(ids.ben);
    expect((await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' })).status).not.toBe('skipped');

    const setBenRole = (role: 'member' | 'viewer') => mutateAccounts(current => ({
      ...current!, teams: current!.teams.map(item => ({ ...item, members: item.members.map(member =>
        member.userId === ids.ben ? { ...member, role } : member) })),
    }));
    await setBenRole('viewer');
    const paused = await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' });
    expect(paused).toMatchObject({ status: 'skipped', error: expect.stringMatching(/^Paused: the person who set this up/) });
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    await setBenRole('member');
    expect((await scheduler.fire(execution!, { kind: 'schedule', summary: 'Schedule' })).status).not.toBe('skipped');
    expect(runFlowMock).toHaveBeenCalledTimes(2);
  });

  it('pause in a workspace nobody owns', async () => {
    await mutateAccounts(() => accounts());
    expect(await backgroundWorkPause('loose-ws')).toMatchObject({ paused: true });
    expect(await backgroundWorkPause('ben-ws')).toEqual({ paused: false });
  });
});
