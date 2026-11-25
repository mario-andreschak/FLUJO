import { InvalidWorkspaceNameError, WorkspaceMutationError, createWorkspace, listWorkspaces } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { workspaceGrant } from './access';
import { recordWorkspaceCreated } from './admin';
import { loadAccountsState } from './store';
import type { AccountUser } from '@/shared/types/accounts';

const log = createLogger('backend/services/accounts/personalWorkspace');

function baseName(user: AccountUser): string {
  const cleaned = user.name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return (cleaned || 'person').slice(0, 54);
}

/**
 * Make sure a person can open FLUJO: someone who owns no workspace yet gets a
 * personal one named after them on sign-in. Admins see every workspace, so
 * they need none. Best effort: a failure is logged and the person can still
 * create a workspace themselves.
 */
export async function ensurePersonalWorkspace(user: AccountUser): Promise<string | null> {
  const state = await loadAccountsState();
  if (state.mode !== 'on' || user.role === 'admin') return null;
  const existing = (await listWorkspaces()).map(workspace => workspace.name);
  if (existing.some(name => workspaceGrant(state.accounts, user, name) !== null)) return null;
  const taken = new Set(existing.map(name => name.toLowerCase()));
  const base = baseName(user);
  for (let attempt = 1; attempt <= 50; attempt++) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    if (taken.has(name.toLowerCase())) continue;
    try {
      await createWorkspace(name);
      await recordWorkspaceCreated(name, user.id);
      return name;
    } catch (error) {
      if (error instanceof InvalidWorkspaceNameError
        || (error instanceof WorkspaceMutationError && error.code === 'WORKSPACE_ALREADY_EXISTS')) continue;
      log.warn(`Could not create a personal workspace for ${user.id}`, error);
      return null;
    }
  }
  return null;
}
