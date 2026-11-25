import { listWorkspaces } from '@/utils/workspace';
import {
  addUser, assignWorkspace, changeUser, mayAdminister, publicUser,
} from '@/backend/services/accounts/admin';
import { accountRequestUser, type AccountRequestUser } from '@/backend/services/accounts/requestAccess';
import {
  accountErrorResponse, adminRequired, json, multiUserOff, readJsonObject, sameOriginChange, signInRequired,
} from '../_shared';

// FLUJO_INSTALLATION_WIDE_ROUTE: admins manage the people of a multi-user installation (#574).

export const runtime = 'nodejs';

type Admin = AccountRequestUser & { user: NonNullable<AccountRequestUser['user']> };

async function admin(request: Request): Promise<Admin | Response> {
  const current = await accountRequestUser(request);
  if (!current) return multiUserOff();
  if (!current.user) return signInRequired();
  if (!mayAdminister(current.user)) return adminRequired();
  return current as Admin;
}

/** Everyone, and who owns each workspace. Unassigned workspaces have `ownerId: null`. */
export async function GET(request: Request): Promise<Response> {
  try {
    const current = await admin(request);
    if (current instanceof Response) return current;
    const { accounts } = current;
    const workspaces = (await listWorkspaces()).map(workspace => {
      const owner = Object.prototype.hasOwnProperty.call(accounts.workspaces, workspace.name)
        ? accounts.workspaces[workspace.name] : undefined;
      return { name: workspace.name, ownerType: owner?.ownerType ?? null, ownerId: owner?.ownerId ?? null };
    });
    return json({
      revision: accounts.revision,
      me: current.user.id,
      users: accounts.users.map(publicUser),
      teams: accounts.teams.map(team => ({ id: team.id, name: team.name })),
      workspaces,
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/** Add a person: `{ name, displayName?, password, role?, hostAccess? }`. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  try {
    const current = await admin(request);
    if (current instanceof Response) return current;
    const body = await readJsonObject(request);
    if (!body) return json({ error: 'Send the new person as JSON.' }, 400);
    return json({ user: await addUser(body, current.user.id) }, 201);
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/** Change a person: `{ id, disabled?, role?, hostAccess?, displayName?, password?, expectedRevision? }`. */
export async function PATCH(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  try {
    const current = await admin(request);
    if (current instanceof Response) return current;
    const body = await readJsonObject(request);
    if (!body || typeof body.id !== 'string') return json({ error: 'Say which person to change.' }, 400);
    const expected = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined;
    return json({ user: await changeUser(body.id, body, current.user.id, expected) });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/** Give a workspace to a person or a team: `{ workspace, ownerId, ownerType? }` (`ownerType` is `user` or `team`). */
export async function PUT(request: Request): Promise<Response> {
  if (!sameOriginChange(request)) return json({ error: 'Forbidden' }, 403);
  try {
    const current = await admin(request);
    if (current instanceof Response) return current;
    const body = await readJsonObject(request);
    if (!body || typeof body.workspace !== 'string' || typeof body.ownerId !== 'string') {
      return json({ error: 'Say which workspace goes to which person.' }, 400);
    }
    if (!(await listWorkspaces()).some(workspace => workspace.name === body.workspace)) {
      return json({ error: `Unknown workspace: ${body.workspace}` }, 404);
    }
    const ownerType = body.ownerType === 'team' ? 'team' : 'user';
    await assignWorkspace(body.workspace, body.ownerId, current.user, Date.now(), ownerType);
    return json({ workspace: body.workspace, ownerId: body.ownerId, ownerType });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
