import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { WorkspaceMutationError, sameFilesystemPath } from '@/utils/workspace';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { mcpService } from '@/backend/services/mcp';
import {
  ProjectGitError,
  addProjectWorktree,
  createProjectBranch,
  isProjectCheckout,
  readProjectGit,
  removeProjectWorktree,
  switchProjectBranch,
  type ProjectGitStatus,
} from '@/backend/services/projects/projectGit';
import {
  addProject,
  bindChatProject,
  isValidConversationId,
  loadProjectState,
  readChatBinding,
  removeProject,
  setActiveProject,
} from '@/backend/services/projects/projectStore';

const log = createLogger('app/api/projects/route');

/**
 * Projects of the selected workspace and their Git state.
 *
 * GET  ?conversationId=… → every project with its Git state, the project new
 *      chats start in, and — for a conversation — the folder that chat works in.
 * POST { action, … }     → add/remove/activate a project, bind a chat to a
 *      project folder, switch/create a branch, or add/remove a worktree. Every
 *      action answers with the refreshed GET payload.
 */

interface ProjectEntry {
  path: string;
  name: string;
  git: ProjectGitStatus | null;
}

interface ChatProjectEntry {
  project: string;
  path: string;
  /** False while the chat still follows the workspace's active project. */
  pinned: boolean;
  git: ProjectGitStatus | null;
}

async function gitOrNull(dir: string): Promise<ProjectGitStatus | null> {
  try {
    return await readProjectGit(dir);
  } catch (error) {
    log.debug(`Could not read Git state of ${dir}`, error);
    return null;
  }
}

async function payload(conversationId?: string) {
  const { projects, activeProject } = await loadProjectState();
  const entries: ProjectEntry[] = await Promise.all(projects.map(async project => ({
    path: project,
    name: path.basename(project) || project,
    git: await gitOrNull(project),
  })));

  let chat: ChatProjectEntry | null = null;
  const { stored, binding } = conversationId
    ? await readChatBinding(conversationId)
    : { stored: undefined, binding: undefined };
  // A chat bound to a removed project has no folder; it never follows the sidebar.
  const chatProject = binding?.project ?? (stored ? undefined : activeProject);
  const chatPath = binding?.path ?? (stored ? undefined : activeProject);
  if (chatProject && chatPath) {
    const sameAsProject = sameFilesystemPath(chatProject, chatPath);
    chat = {
      project: chatProject,
      path: chatPath,
      pinned: Boolean(binding),
      git: sameAsProject
        ? entries.find(entry => entry.path === chatProject)?.git ?? null
        : await gitOrNull(chatPath),
    };
  }
  return { projects: entries, activeProject: activeProject ?? null, chat };
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ProjectGitError) {
    const status = error.code === 'DIRTY_WORKTREE' || error.code === 'WORKTREE_EXISTS' || error.code === 'GIT_FAILED'
      ? 409
      : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  if (error instanceof WorkspaceMutationError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.code === 'WORKSPACE_NOT_FOUND' ? 404 : 400 },
    );
  }
  log.error('Project request failed', error);
  return NextResponse.json({ error: 'The project could not be updated.' }, { status: 500 });
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The project whose checkout (main folder or worktree) `folder` is. */
async function projectOwning(folder: string | undefined): Promise<string> {
  if (!folder || !path.isAbsolute(folder)) {
    throw new WorkspaceMutationError('WORKSPACE_INVALID_ROOTS', 'A project folder is required.');
  }
  const { projects } = await loadProjectState();
  const direct = projects.find(project => sameFilesystemPath(project, folder));
  if (direct) return direct;
  const owners = await Promise.all(projects.map(async project => (await isProjectCheckout(project, folder)) ? project : null));
  const owner = owners.find((project): project is string => project !== null);
  if (owner) return owner;
  throw new WorkspaceMutationError('WORKSPACE_INVALID_ROOTS', 'That folder is not a project of this workspace or one of its worktrees.');
}

async function GET_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const conversationId = request.nextUrl.searchParams.get('conversationId') ?? undefined;
  try {
    return NextResponse.json(await payload(isValidConversationId(conversationId) ? conversationId : undefined));
  } catch (error) {
    return errorResponse(error);
  }
}

async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'A JSON body is required.' }, { status: 400 });
  }

  const conversationId = isValidConversationId(body.conversationId) ? body.conversationId : undefined;
  const folder = stringField(body, 'path');
  let rootsChanged = false;
  try {
    switch (body.action) {
      case 'add':
        await addProject(folder);
        rootsChanged = true;
        break;
      case 'remove':
        await removeProject(stringField(body, 'project'));
        rootsChanged = true;
        break;
      case 'activate':
        await setActiveProject(stringField(body, 'project'));
        rootsChanged = true;
        break;
      case 'bindChat': {
        if (!conversationId) throw new WorkspaceMutationError('WORKSPACE_INVALID_ROOTS', 'A conversation is required.');
        const project = folder ? await projectOwning(folder) : stringField(body, 'project');
        await bindChatProject(conversationId, project, folder);
        break;
      }
      case 'switchBranch':
        await projectOwning(folder);
        await switchProjectBranch(folder!, body.branch);
        break;
      case 'createBranch':
        await projectOwning(folder);
        await createProjectBranch(folder!, body.branch);
        break;
      case 'addWorktree': {
        const project = await projectOwning(folder);
        const created = await addProjectWorktree(folder!, body.branch, body.createBranch === true);
        if (conversationId) await bindChatProject(conversationId, project, created);
        rootsChanged = true;
        break;
      }
      case 'removeWorktree': {
        const worktree = stringField(body, 'worktree');
        await removeProjectWorktree(await projectOwning(folder), worktree ?? '');
        break;
      }
      default:
        return NextResponse.json({ error: 'Unknown project action.' }, { status: 400 });
    }
    if (rootsChanged) mcpService.notifyAllRootsChanged();
    return NextResponse.json(await payload(conversationId));
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
