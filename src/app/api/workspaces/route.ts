import { NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import {
  DEFAULT_WORKSPACE,
  InvalidWorkspaceNameError,
  WorkspaceMutationError,
  assertWorkspaceRoots,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  renameWorkspace,
  runWithWorkspace,
  updateWorkspaceRoots,
} from '@/utils/workspace';
import { mcpService } from '@/backend/services/mcp';
import {
  getWorkspaceLayoutStatus,
  waitForWorkspaceLayoutReady,
} from '@/backend/services/workspace/layoutReadiness';

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

/** Installation-wide discovery; the filesystem remains the source of truth. */
export async function GET() {
  const unavailable = await waitForLayout();
  if (unavailable) return unavailable;

  try {
    const workspaces = await listWorkspaces();
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
    const workspace = await createWorkspace(body.name as string);
    return NextResponse.json(
      { workspace, workspaces: await listWorkspaces() },
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
    const workspace = Object.prototype.hasOwnProperty.call(body, 'roots')
      ? await updateWorkspaceRoots(renamed.name, body.roots)
      : renamed;
    if (Object.prototype.hasOwnProperty.call(body, 'roots')) {
      runWithWorkspace(workspace.name, () => mcpService.notifyAllRootsChanged());
    }
    return NextResponse.json({ workspace, workspaces: await listWorkspaces() });
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
    const name = body.name as string;
    await deleteWorkspace(name);
    return NextResponse.json({ deleted: name, workspaces: await listWorkspaces() });
  } catch (error) {
    return mutationErrorResponse(error, 'delete');
  }
}
