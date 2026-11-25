import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AccountsConflictError, AccountsDamagedError, appendAudit, accountsDirectory, accountsFilePath, loadAccountsState,
  loadEnabledAccounts, loadSessions, mutateAccounts, mutateSessions, resetAccountsStoreCache,
} from '@/backend/services/accounts/store';
import { AUDIT_ROTATE_BYTES, type AccountsFile } from '@/shared/types/accounts';
import { accountsFixture, NOW } from './fixtures';
import { useTemporaryDataDir } from './helpers';

describe('accounts store', () => {
  let restore: () => Promise<void>;
  let dir: string;
  beforeEach(async () => ({ dir, restore } = await useTemporaryDataDir()));
  afterEach(async () => restore());

  const seed = (overrides: Partial<AccountsFile> = {}) => mutateAccounts(() => accountsFixture(overrides));

  it('treats a missing file as mode off and creates nothing', async () => {
    const readFile = jest.spyOn(fs, 'readFile');
    try {
      expect(await loadAccountsState()).toEqual({ mode: 'off', accounts: null });
      expect(await loadEnabledAccounts()).toBeNull();
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }
    await expect(fs.stat(accountsDirectory())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('saves and loads the file, raising the revision by one each time', async () => {
    const first = await seed();
    expect(first.revision).toBe(1);
    const second = await mutateAccounts(current => ({ ...current!, enabled: false }));
    expect(second.revision).toBe(2);
    resetAccountsStoreCache();
    expect(await loadAccountsState()).toMatchObject({ mode: 'off', accounts: { revision: 2, enabled: false } });
    const backup = JSON.parse(await fs.readFile(`${accountsFilePath()}.bak`, 'utf8'));
    expect(backup.revision).toBe(2);
  });

  it('serialises parallel writes so none is lost', async () => {
    await seed({ workspaces: {} });
    await Promise.all(Array.from({ length: 12 }, (_, index) => mutateAccounts(current => ({
      ...current!,
      workspaces: { ...current!.workspaces, [`ws-${index}`]: { ownerType: 'user', ownerId: current!.users[0].id, assignedAt: NOW } },
    }))));
    const state = await loadAccountsState();
    expect(state.mode).toBe('on');
    expect(Object.keys(state.accounts!.workspaces)).toHaveLength(12);
    expect(state.accounts!.revision).toBe(13);
  });

  it('refuses a write based on an older revision', async () => {
    await seed();
    await expect(mutateAccounts(current => current!, { expectedRevision: 0 })).rejects.toBeInstanceOf(AccountsConflictError);
    expect((await mutateAccounts(current => current!, { expectedRevision: 1 })).revision).toBe(2);
  });

  it('never writes a file the server would refuse', async () => {
    await seed();
    const before = await fs.readFile(accountsFilePath(), 'utf8');
    await expect(mutateAccounts(current => ({
      ...current!, users: current!.users.map(user => ({ ...user, role: 'member' as const })),
    }))).rejects.toThrow(/active admin/);
    expect(await fs.readFile(accountsFilePath(), 'utf8')).toBe(before);
  });

  it('falls back to the .bak copy when the main file is damaged, and heals once it is fixed', async () => {
    const saved = await seed();
    await fs.writeFile(accountsFilePath(), '{ broken');
    expect(await loadAccountsState()).toMatchObject({ mode: 'on', accounts: { revision: saved.revision } });
    await fs.writeFile(`${accountsFilePath()}.bak`, 'also broken');
    expect(await loadAccountsState()).toEqual({ mode: 'damaged', accounts: null });
    await expect(loadEnabledAccounts()).rejects.toBeInstanceOf(AccountsDamagedError);
    await expect(mutateAccounts(current => current!)).rejects.toBeInstanceOf(AccountsDamagedError);
    await fs.writeFile(accountsFilePath(), JSON.stringify({ ...saved, enabled: false }));
    expect(await loadAccountsState()).toMatchObject({ mode: 'off', accounts: { enabled: false } });
  });

  it('notices a change made by another process without a restart', async () => {
    const saved = await seed();
    expect((await loadAccountsState()).mode).toBe('on');
    await fs.writeFile(accountsFilePath(), JSON.stringify({ ...saved, enabled: false, revision: 9 }, null, 1));
    expect(await loadAccountsState()).toMatchObject({ mode: 'off', accounts: { revision: 9 } });
    await fs.rm(accountsFilePath());
    expect(await loadAccountsState()).toEqual({ mode: 'off', accounts: null });
  });

  it('drops expired sessions on every write and survives a damaged sessions file', async () => {
    const session = (id: string, expiresAt: number) => ({
      id: `${id}0000000000000000`, digest: id.repeat(64).slice(0, 64), userId: 'u_anna000000000000000', userGeneration: 2,
      issuedAt: expiresAt - 1000, expiresAt,
    });
    await mutateSessions(() => ({ schemaVersion: 1, sessions: [session('a', NOW + 5000), session('b', NOW - 10)] }), NOW);
    expect((await loadSessions()).sessions.map(item => item.id)).toEqual(['a0000000000000000']);
    await fs.writeFile(path.join(accountsDirectory(), 'sessions.json'), 'nope');
    expect((await loadSessions()).sessions).toEqual([]);
    await mutateSessions(current => current, NOW);
    expect(JSON.parse(await fs.readFile(path.join(accountsDirectory(), 'sessions.json'), 'utf8'))).toEqual({ schemaVersion: 1, sessions: [] });
  });

  it('appends audit lines without secrets and moves a big log aside instead of failing', async () => {
    await appendAudit({ action: 'sign-in', actorUserId: 'u_anna000000000000000' });
    const file = path.join(accountsDirectory(), 'audit.jsonl');
    expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1);
    await fs.writeFile(file, 'x'.repeat(AUDIT_ROTATE_BYTES));
    await appendAudit({ action: 'sign-out', actorUserId: null });
    expect((await fs.stat(path.join(accountsDirectory(), 'audit.1.jsonl'))).size).toBe(AUDIT_ROTATE_BYTES);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ action: 'sign-out' });
    await expect(appendAudit({ action: 'sign-out', actorUserId: 'not-a-user-id' })).resolves.toBeUndefined();
  });
});
