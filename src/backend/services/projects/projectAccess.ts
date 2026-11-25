/**
 * Whether a chat's agents can really work in a folder.
 *
 * The shipped bash and filesystem servers use a chat's folder only when it
 * exists and lies inside the folders they may use. Normally that is the whole
 * computer. With "Restrict MCP filesystem access to configured roots" on, it
 * is the workspace's projects plus their `<repo>.worktrees` folders; a chat
 * folder anywhere else would quietly fall back to FLUJO's data folder.
 */
import fs from 'fs/promises';
import { WorkspaceMutationError } from '@/utils/workspace';
import { isInside } from '@/backend/services/mcp/internal/confinement';
import { loadMcpRootsRestriction } from '@/backend/services/mcp/roots';
import { loadWorkspaceProjectRoots } from './projectStore';

export async function agentsCanWorkIn(folder: string): Promise<boolean> {
  if (!(await loadMcpRootsRestriction())) return true;
  const roots = await loadWorkspaceProjectRoots();
  return roots.some(root => isInside(root, folder));
}

/** Refuse a chat folder the agents could not use, saying how to fix it. */
export async function assertAgentsCanWorkIn(folder: string): Promise<void> {
  if (await agentsCanWorkIn(folder)) return;
  throw new WorkspaceMutationError(
    'WORKSPACE_INVALID_ROOTS',
    `Agents cannot work in ${folder}: "Restrict MCP filesystem access to configured roots" is on `
      + '(Settings → Experimental features) and this folder is outside your projects. '
      + 'Add it as a project first, or turn that setting off.',
  );
}

export interface ChatFolderUse {
  /** The folder cannot be found: deleted, renamed or on a drive that is not connected. */
  missing: boolean;
  /** False when folder restrictions keep the agents out of this folder. */
  agentsCanWork: boolean;
}

/** What the chat chip must warn about for the folder a chat works in. */
export async function chatFolderUse(folder: string): Promise<ChatFolderUse> {
  const [exists, agentsCanWork] = await Promise.all([
    fs.stat(folder).then(stats => stats.isDirectory(), () => false),
    agentsCanWorkIn(folder),
  ]);
  return { missing: !exists, agentsCanWork };
}
