import { getCurrentWorkspace } from '@/utils/workspace';
import { REVEAL_SECRETS_ACTION, decideWorkspaceAccess } from './access';
import { currentAccountPrincipal } from './context';
import { denialResponse } from './requestAccess';
import { loadEnabledAccounts } from './store';

/**
 * Workspace `admin` steps that a route only recognises from its body or query
 * (`WORKSPACE_ADMIN_STEPS` in `routeCapabilities.ts`): showing stored secrets
 * in plain text and setting or changing the workspace password. Team members
 * use a team's keys in runs but never see them (#575); only the personal or
 * team owner and admins may take these steps.
 *
 * Returns the answer to send instead, or `null` to go on. With multi-user mode
 * off there is no signed-in person in the request and this returns `null`
 * before reading anything.
 */
export async function workspaceAdminStepRefused(now = Date.now()): Promise<Response | null> {
  const principal = currentAccountPrincipal();
  if (!principal) return null;
  const accounts = await loadEnabledAccounts();
  if (!accounts) return null;
  const workspace = getCurrentWorkspace();
  const decision = decideWorkspaceAccess(accounts, principal, workspace, REVEAL_SECRETS_ACTION, now);
  return decision.allowed ? null : denialResponse(decision.denial, workspace);
}
