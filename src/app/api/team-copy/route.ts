import { NextRequest } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace, listWorkspaces, workspaceExists } from '@/utils/workspace';
import { WORKSPACE_NAME_PATTERN } from '@/shared/types/accounts';
import { decideWorkspaceAccess } from '@/backend/services/accounts/access';
import { currentAccountPrincipal } from '@/backend/services/accounts/context';
import { unknownWorkspaceResponse } from '@/backend/services/accounts/requestAccess';
import { currentSharedEditor } from '@/backend/services/sharedItems/guard';
import { isSharedItemId, isSharedItemKind } from '@/backend/services/sharedItems/kinds';
import { TeamCopyError, copySharedItem } from '@/backend/services/sharedItems/teamCopy';

const log = createLogger('app/api/team-copy/route');

/**
 * Copy a flow, model or MCP server from the selected workspace into another
 * workspace the signed-in person may edit, usually a team workspace (#575).
 * Keys, tokens, passwords and private folders are never copied; the answer
 * lists what the person must enter in the target workspace.
 *
 * - `GET`: `{ enabled, targets }`, the workspaces the person may copy into.
 * - `POST { kind, id, targetWorkspace }`: copy. A workspace the person may not
 *   edit answers exactly like one that does not exist.
 *
 * Only while multi-user mode is on: with it off, `GET` answers
 * `{ enabled: false }` and `POST` answers 409.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

const MULTI_USER_OFF = { error: 'Copying into a team workspace needs sign-in for several people to be on.', code: 'MULTI_USER_OFF' };

async function GET_handler(_request: NextRequest): Promise<Response> {
  // Mode off: answer before reading anything (not even the lock state).
  const editor = await currentSharedEditor();
  const principal = currentAccountPrincipal();
  if (!editor || !principal) return json({ enabled: false });
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  try {
    const now = Date.now();
    const source = getCurrentWorkspace();
    const targets = (await listWorkspaces())
      .filter(workspace => workspace.name !== source)
      .filter(workspace => decideWorkspaceAccess(editor.accounts, principal, workspace.name, 'edit', now).allowed)
      .map(workspace => {
        const owner = Object.prototype.hasOwnProperty.call(editor.accounts.workspaces, workspace.name)
          ? editor.accounts.workspaces[workspace.name] : undefined;
        const team = owner?.ownerType === 'team' ? editor.accounts.teams.find(candidate => candidate.id === owner.ownerId) : undefined;
        return {
          workspace: workspace.name,
          ownerType: owner?.ownerType ?? null,
          ...(team ? { teamName: team.name } : {}),
          mine: owner?.ownerType === 'user' && owner.ownerId === editor.user.id,
        };
      })
      .sort((a, b) => Number(b.ownerType === 'team') - Number(a.ownerType === 'team') || a.workspace.localeCompare(b.workspace));
    return json({ enabled: true, targets });
  } catch (error) {
    log.error('Listing copy targets failed', error);
    return json({ error: 'Could not list the workspaces. Try again.' }, 500);
  }
}

async function POST_handler(request: NextRequest): Promise<Response> {
  const editor = await currentSharedEditor();
  const principal = currentAccountPrincipal();
  if (!editor || !principal) return json(MULTI_USER_OFF, 409);
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  try {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await request.json();
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { /* not JSON */ }
    if (!body || !isSharedItemKind(body.kind) || !isSharedItemId(body.id)
        || typeof body.targetWorkspace !== 'string' || !WORKSPACE_NAME_PATTERN.test(body.targetWorkspace)) {
      return json({ error: 'Say what to copy (kind and id) and into which workspace (targetWorkspace).' }, 400);
    }
    const target = body.targetWorkspace;
    // Unknown, forbidden and read-only targets all look the same, so guessing names reveals nothing.
    const decision = decideWorkspaceAccess(editor.accounts, principal, target, 'edit', Date.now());
    if (!decision.allowed || !(await workspaceExists(target))) return unknownWorkspaceResponse(target);
    const result = await copySharedItem({ kind: body.kind, id: body.id, targetWorkspace: target, editor });
    return json(result, 201);
  } catch (error) {
    if (error instanceof TeamCopyError) {
      return json({ error: error.message, code: error.code, missingDependencies: error.missingDependencies }, error.status);
    }
    log.error('Copying into another workspace failed', error);
    return json({ error: 'The copy could not be finished. Look in the other workspace, then try again.' }, 500);
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
