/**
 * Multi-user mode, step 574-4: starting a program on the server needs host
 * access for the person behind the request, or for the workspace owner when
 * FLUJO starts it by itself.
 */
import { runWithAccountPrincipal } from '@/backend/services/accounts/context';
import { HostAccessRequiredError, assertHostAccess, mayStartHostProgram } from '@/backend/services/accounts/hostAccess';
import { mutateAccounts } from '@/backend/services/accounts/store';
import { attachHostAccessCheck } from '@/backend/services/mcp/connection';
import { runWithWorkspace } from '@/utils/workspace';
import type { AccountsFile, AccountUser } from '@/shared/types/accounts';
import { passwordHash } from './fixtures';
import { useTemporaryDataDir } from './helpers';

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


describe('starting programs on the server', () => {
  let restore: () => Promise<void>;
  beforeEach(async () => ({ restore } = await useTemporaryDataDir()));
  afterEach(async () => restore());

  const session = (userId: string) => ({ kind: 'session' as const, userId, sessionId: `s_${userId}`, generation: 1 });

  it('is allowed for everyone while multi-user mode is off', async () => {
    await expect(assertHostAccess('local-mcp-server')).resolves.toBeUndefined();
    await expect(runWithAccountPrincipal(session(ids.anna), () => mayStartHostProgram())).resolves.toBe(true);
  });

  it('needs host access for the person behind the request', async () => {
    await mutateAccounts(() => accounts());
    await expect(runWithAccountPrincipal(session(ids.anna), () => assertHostAccess('command-line-model')))
      .rejects.toBeInstanceOf(HostAccessRequiredError);
    await expect(runWithAccountPrincipal(session(ids.admin), () => assertHostAccess('command-line-model'))).resolves.toBeUndefined();
    await expect(runWithAccountPrincipal(session(ids.ben), () => assertHostAccess('github-install'))).resolves.toBeUndefined();
  });

  it('asks the workspace owner when FLUJO starts a program by itself', async () => {
    await mutateAccounts(() => accounts());
    await expect(runWithWorkspace('default-workspace', () => mayStartHostProgram())).resolves.toBe(false);
    await expect(runWithWorkspace('admin-ws', () => mayStartHostProgram())).resolves.toBe(true);
    await expect(runWithWorkspace('ben-ws', () => mayStartHostProgram())).resolves.toBe(true);
    await expect(runWithWorkspace('loose-ws', () => mayStartHostProgram())).resolves.toBe(false);
  });

  it('stops a local MCP server before it spawns and tells the person what to do instead', async () => {
    await mutateAccounts(() => accounts());
    const spawn = jest.fn(async () => undefined);
    const transport = { start: spawn };
    attachHostAccessCheck(transport);
    const refused = runWithAccountPrincipal(session(ids.anna), () => transport.start());
    await expect(refused).rejects.toThrow(/container profile or a remote server/);
    expect(spawn).not.toHaveBeenCalled();
    await runWithAccountPrincipal(session(ids.admin), () => transport.start());
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
