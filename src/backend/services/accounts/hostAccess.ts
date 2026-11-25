import { getCurrentWorkspace } from '@/utils/workspace';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import type { AccountsFile } from '@/shared/types/accounts';
import { activeUser, hasHostAccess } from './access';
import { currentAccountPrincipal } from './context';
import { loadAccountsState } from './store';

/**
 * Starting a program on the server machine (#574, step 574-4). Anyone who can
 * do that can read every person's files, so in multi-user mode it needs host
 * access: admins, or people an admin trusted with it. It is checked where the
 * program starts, not only by route, because ordinary workspace routes and
 * background work lead there too.
 *
 * Inside a signed-in request the person behind the request decides. Without
 * one (schedules, triggers, personas, starting servers when FLUJO starts) the
 * owner of the selected workspace decides. While multi-user mode is off this
 * allows everything, exactly as before.
 */

export type HostActivity =
  | 'local-mcp-server'
  | 'command-line-model'
  | 'github-install'
  | 'system-screenshot'
  | 'owner-native-tool';

const ACTIVITY_WORDS: Readonly<Record<HostActivity, string>> = {
  'local-mcp-server': 'This connected app runs as a program on the server computer',
  'command-line-model': 'This AI runs as a command-line program on the server computer',
  'github-install': 'Installing from GitHub builds and runs programs on the server computer',
  'system-screenshot': 'Taking a screenshot of the server computer',
  'owner-native-tool': 'This tool runs commands and reads folders on the server computer',
};

export class HostAccessRequiredError extends Error {
  readonly status = 403;
  readonly code = 'HOST_ACCESS_REQUIRED';
  readonly activity: HostActivity;
  constructor(activity: HostActivity) {
    super(`${ACTIVITY_WORDS[activity]}. With several people on this FLUJO, only admins and people an admin trusted with host access may start it. `
      + (activity === 'local-mcp-server'
        ? 'Use the isolated container profile or a remote server instead, or ask an admin.'
        : 'Ask an admin.'));
    this.name = 'HostAccessRequiredError';
    this.activity = activity;
  }
}

function workspaceOwnerHasHostAccess(accounts: AccountsFile, workspace: string): boolean {
  const owner = Object.prototype.hasOwnProperty.call(accounts.workspaces, workspace) ? accounts.workspaces[workspace] : undefined;
  if (!owner) return false;
  if (owner.ownerType === 'user') {
    const user = accounts.users.find(candidate => candidate.id === owner.ownerId);
    return user !== undefined && hasHostAccess(user);
  }
  const team = accounts.teams.find(candidate => candidate.id === owner.ownerId);
  return team?.members.some(member => member.state === 'member' && member.role === 'owner'
    && accounts.users.some(user => user.id === member.userId && hasHostAccess(user))) === true;
}

/** Whether the current person (or, for background work, the workspace owner) may start a program on the server now. */
export async function mayStartHostProgram(now = Date.now()): Promise<boolean> {
  if (isWorkerMode()) return true;
  const state = await loadAccountsState();
  if (state.mode === 'off') return true;
  if (state.mode === 'damaged') return false;
  const principal = currentAccountPrincipal();
  if (principal) {
    const user = activeUser(state.accounts, principal, now);
    return user !== null && hasHostAccess(user);
  }
  return workspaceOwnerHasHostAccess(state.accounts, getCurrentWorkspace());
}

/** Throw {@link HostAccessRequiredError} unless {@link mayStartHostProgram}. Call right before the program starts. */
export async function assertHostAccess(activity: HostActivity): Promise<void> {
  if (!(await mayStartHostProgram())) throw new HostAccessRequiredError(activity);
}
