import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import {
  DEFAULT_WORKSPACE,
  InvalidWorkspaceNameError,
  WorkspaceMutationError,
  assertWorkspaceRoots,
  createWorkspace,
  listWorkspaces,
  renameWorkspace,
  runWithWorkspace,
  updateWorkspaceRoots,
  type WorkspaceInfo,
} from '@/utils/workspace';
import { mcpService } from '@/backend/services/mcp';
import {
  getWorkspaceLayoutStatus,
  waitForWorkspaceLayoutReady,
} from '@/backend/services/workspace/layoutReadiness';
import { deleteWorkspace } from '@/backend/services/workspace/workspaceDeletion';
import {
  accountRequestUser, accountsDamagedResponse, denialResponse, unknownWorkspaceResponse, type AccountRequestUser,
} from '@/backend/services/accounts/requestAccess';
import {
  hasHostAccess, listAccessibleWorkspaces, mayCreateWorkspaceFor, workspaceActions,
} from '@/backend/services/accounts/access';
import { recordWorkspaceCreated, recordWorkspaceRenamed } from '@/backend/services/accounts/admin';
import { AccountsDamagedError } from '@/backend/services/accounts/store';

// FLUJO_INSTALLATION_WIDE_ROUTE: discovers and manages workspace namespaces.

const log = createLogger('app/api/workspaces');

function layoutUnavailableResponse(): NextResponse | null {
  const layoutStatus = getWorkspaceLayoutStatus();
  if (layoutStatus !== 'ready') {
    const preparing = layoutStatus === 'preparing';
    return NextResponse.json(
      {
        error: preparing
          ? 'Workspace data is being verified and migrated.'
          : 'Workspace storage is temporarily unavailable.',
        code: preparing ? 'WORKSPACE_LAYOUT_PREPARING' : 'WORKSPACE_LAYOUT_UNAVAILABLE',
      },
      { status: 503, headers: { 'Retry-After': preparing ? '2' : '5' } },
    );
  }
  return null;
}

async function waitForLayout(): Promise<NextResponse | null> {
  const unavailable = layoutUnavailableResponse();
  if (unavailable) return unavailable;
  try {
    await waitForWorkspaceLayoutReady();
    return null;
  } catch (error) {
    log.error('Workspace layout is unavailable', error);
    return NextResponse.json(
      { error: 'Workspace storage is temporarily unavailable.' },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }
}

function mutationErrorResponse(error: unknown, action: string): NextResponse {
  if (error instanceof InvalidWorkspaceNameError) {
    return NextResponse.json(
      {
        error: 'Workspace names must be 1–64 characters and use only letters, numbers, hyphens, or underscores.',
        code: error.code,
      },
      { status: 400 },
    );
  }
  if (error instanceof WorkspaceMutationError) {
    const status = error.code === 'WORKSPACE_INVALID_ROOTS'
      ? 400
      : error.code === 'WORKSPACE_NOT_FOUND'
      ? 404
      : error.code === 'DEFAULT_WORKSPACE_PROTECTED'
        ? 403
        : 409;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  log.error(`Failed to ${action} workspace`, error);
  return NextResponse.json(
    { error: `Could not ${action} the workspace.` },
    { status: 500 },
  );
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

type SignedIn = AccountRequestUser & { user: NonNullable<AccountRequestUser['user']> };

/**
 * Multi-user mode (#574): the signed-in person, `null` while the mode is off,
 * or the answer to send instead (signed out, damaged accounts file).
 */
async function signedInPerson(request: Request | undefined): Promise<SignedIn | null | Response> {
  try {
    const current = await accountRequestUser(request ?? new Request('http://localhost/api/workspaces'));
    if (!current) return null;
    return current.user ? current as SignedIn : denialResponse('sign-in-required', '');
  } catch (error) {
    if (error instanceof AccountsDamagedError) return accountsDamagedResponse();
    throw error;
  }
}

/** Only the workspaces this person may open. Unknown and forbidden names look the same. */
async function visibleWorkspaces(request: Request | undefined, person: SignedIn | null): Promise<WorkspaceInfo[]> {
  const workspaces = await listWorkspaces();
  if (!person) return workspaces;
  const current = await signedInPerson(request);
  if (!current || current instanceof Response) return [];
  const entries = listAccessibleWorkspaces(current.accounts, current.principal, workspaces.map(workspace => workspace.name), Date.now());
  if (!Array.isArray(entries)) return [];
  const allowed = new Set(entries.map(entry => entry.workspace));
  return workspaces.filter(workspace => allowed.has(workspace.name));
}

/** In multi-user mode, renaming, deleting and changing folders need the workspace `admin` action; folders also need host access. */
function workspaceChangeRefused(person: SignedIn | null, name: unknown, changesRoots: boolean): Response | null {
  if (!person) return null;
  const workspace = typeof name === 'string' ? name : '';
  const actions = workspaceActions(person.accounts, person.user, workspace);
  if (!actions.includes('admin')) {
    return actions.length > 0 ? denialResponse('workspace-admin-required', workspace) : unknownWorkspaceResponse(workspace);
  }
  return changesRoots && !hasHostAccess(person.user) ? denialResponse('host-access-required', workspace) : null;
}

/** Installation-wide discovery; the filesystem remains the source of truth. */
export function GET(): Promise<Response>;
export function GET(request: Request): Promise<Response>;
export async function GET(request: Request = new Request('http://localhost/api/workspaces')) {
  const unavailable = await waitForLayout();
  if (unavailable) return unavailable;

  try {
    const person = await signedInPerson(request);
    if (person instanceof Response) return person;
    const workspaces = await visibleWorkspaces(request, person);
    return NextResponse.json({
      workspaces,
      defaultWorkspace: DEFAULT_WORKSPACE,
    });
  } catch (error) {
    log.error('Failed to list workspaces', error);
    // Returning a fabricated default list would invite the client to open a
    // layout whose migration failed. Fail closed and let it retry instead.
    return NextResponse.json(
      { error: 'Workspace storage is temporarily unavailable.' },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }
}

export async function POST(request: Request) {
  const unavailable = await waitForLayout();
  if (unavailable) return unavailable;
  const body = await requestBody(request);
  if (!body) {
    return NextResponse.json({ error: 'A workspace name is required.' }, { status: 400 });
  }
  try {
    const person = await signedInPerson(request);
    if (person instanceof Response) return person;
    // Multi-user mode (#575): `teamId` creates a workspace the team owns. Team
    // owners and admins may; anyone else is told the team does not exist.
    const teamId = person && typeof body.teamId === 'string' && body.teamId ? body.teamId : undefined;
    if (person && teamId && !mayCreateWorkspaceFor(person.accounts, person.user, { ownerType: 'team', ownerId: teamId })) {
      return NextResponse.json({ error: 'No such team, or you are not one of its owners.' }, { status: 404 });
    }
    const workspace = await createWorkspace(body.name as string);
    await recordWorkspaceCreated(workspace.name, person?.user.id ?? null, Date.now(), teamId);
    return NextResponse.json(
      { workspace, workspaces: await visibleWorkspaces(request, person) },
      { status: 201 },
    );
  } catch (error) {
    return mutationErrorResponse(error, 'create');
  }
}

export async function PATCH(request: Request) {
  const unavailable = await waitForLayout();
  if (unavailable) return unavailable;
  const body = await requestBody(request);
  if (!body) {
    return NextResponse.json(
      { error: 'The current and new workspace names are required.' },
      { status: 400 },
    );
  }
  try {
    const person = await signedInPerson(request);
    if (person instanceof Response) return person;
    const refused = workspaceChangeRefused(person, body.name, Object.prototype.hasOwnProperty.call(body, 'roots'));
    if (refused) return refused;
    const currentName = body.name as string;
    const newName = body.newName as string;
    if (Object.prototype.hasOwnProperty.call(body, 'roots')) assertWorkspaceRoots(body.roots);
    const renamed = currentName === newName
      ? (await listWorkspaces()).find(workspace => workspace.name === currentName)
      : await renameWorkspace(currentName, newName);
    if (!renamed) {
      throw new WorkspaceMutationError(
        'WORKSPACE_NOT_FOUND',
        `Workspace ${JSON.stringify(currentName)} does not exist.`,
      );
    }
    if (renamed.name !== currentName) await recordWorkspaceRenamed(currentName, renamed.name);
    const workspace = Object.prototype.hasOwnProperty.call(body, 'roots')
      ? await updateWorkspaceRoots(renamed.name, body.roots)
      : renamed;
    if (Object.prototype.hasOwnProperty.call(body, 'roots')) {
      runWithWorkspace(workspace.name, () => mcpService.notifyAllRootsChanged());
    }
    return NextResponse.json({ workspace, workspaces: await visibleWorkspaces(request, person) });
  } catch (error) {
    return mutationErrorResponse(error, 'edit');
  }
}

export async function DELETE(request: Request) {
  const unavailable = await waitForLayout();
  if (unavailable) return unavailable;
  const body = await requestBody(request);
  if (!body) {
    return NextResponse.json({ error: 'A workspace name is required.' }, { status: 400 });
  }
  try {
    const person = await signedInPerson(request);
    if (person instanceof Response) return person;
    const refused = workspaceChangeRefused(person, body.name, false);
    if (refused) return refused;
    const name = body.name as string;
    await deleteWorkspace(name);
    await recordWorkspaceRenamed(name, null);
    return NextResponse.json({ deleted: name, workspaces: await visibleWorkspaces(request, person) });
  } catch (error) {
    return mutationErrorResponse(error, 'delete');
  }
}
