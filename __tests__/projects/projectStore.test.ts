import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspace,
  listWorkspaces,
  readWorkspaceMetadata,
  runWithWorkspace,
  updateWorkspaceRoots,
} from '@/utils/workspace';
import {
  addProject,
  bindChatProject,
  getChatProject,
  loadProjectState,
  loadWorkspaceProjectRoots,
  projectDirForToolCall,
  removeProject,
  resolveConversationProjectDir,
  setActiveProject,
} from '@/backend/services/projects/projectStore';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { getConversationStates } from '@/backend/execution/flow/conversationStateRegistry';
import type { SharedState } from '@/backend/execution/flow/types';

describe('workspace projects', () => {
  let dataRoot: string;
  let priorDataDir: string | undefined;
  let one: string;
  let two: string;
  const inWorkspace = <T>(fn: () => Promise<T>) => runWithWorkspace('side', fn);

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-projects-'));
    process.env.FLUJO_DATA_DIR = dataRoot;
    one = path.join(dataRoot, 'code', 'one');
    two = path.join(dataRoot, 'code', 'two');
    await fs.mkdir(one, { recursive: true });
    await fs.mkdir(two, { recursive: true });
    await createWorkspace('side');
  });

  afterEach(async () => {
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  it('adds folders as projects and tracks the one new chats start in', async () => {
    await inWorkspace(() => addProject(one));
    await inWorkspace(() => addProject(two));
    await expect(inWorkspace(loadProjectState)).resolves.toEqual({ projects: [one, two], activeProject: two });

    await inWorkspace(() => setActiveProject(one));
    expect((await listWorkspaces()).find(w => w.name === 'side')).toMatchObject({ roots: [one, two], activeProject: one });
    await expect(inWorkspace(() => setActiveProject(dataRoot))).rejects.toMatchObject({ code: 'WORKSPACE_INVALID_ROOTS' });
    await expect(inWorkspace(() => addProject(path.join(dataRoot, 'missing')))).rejects.toMatchObject({ code: 'WORKSPACE_INVALID_ROOTS' });
  });

  it('pins an unbound chat to the active project and keeps explicit bindings', async () => {
    await inWorkspace(() => addProject(one));
    await expect(inWorkspace(() => resolveConversationProjectDir('chat-1'))).resolves.toBe(one);

    await inWorkspace(() => addProject(two));
    // The earlier chat stays where it started; a fresh chat follows the sidebar.
    await expect(inWorkspace(() => resolveConversationProjectDir('chat-1'))).resolves.toBe(one);
    await expect(inWorkspace(() => resolveConversationProjectDir('chat-2'))).resolves.toBe(two);

    const worktree = path.join(dataRoot, 'code', 'one.worktrees', 'feat');
    await fs.mkdir(worktree, { recursive: true });
    await inWorkspace(() => bindChatProject('chat-1', one, worktree));
    await expect(inWorkspace(() => getChatProject('chat-1'))).resolves.toEqual({ project: one, path: worktree });
    // A vanished worktree falls back to the project's main checkout.
    await fs.rm(worktree, { recursive: true });
    await expect(inWorkspace(() => getChatProject('chat-1'))).resolves.toEqual({ project: one, path: one });
  });

  it('treats conversation ids that name Object members like any other id', async () => {
    await inWorkspace(() => addProject(one));
    await expect(inWorkspace(() => resolveConversationProjectDir('constructor'))).resolves.toBe(one);
    await expect(inWorkspace(() => getChatProject('toString'))).resolves.toBeUndefined();
    expect(Object.keys((await readWorkspaceMetadata('side')).chatProjects as object)).toEqual(['constructor']);
  });

  it('keeps project fields when the workspace editor rewrites the roots', async () => {
    await inWorkspace(() => addProject(one));
    await inWorkspace(() => bindChatProject('chat-1', one));
    await updateWorkspaceRoots('side', [one, two]);
    const metadata = await readWorkspaceMetadata('side');
    expect(metadata).toMatchObject({ roots: [one, two], activeProject: one });
    expect(metadata.chatProjects).toHaveProperty('chat-1');
  });

  it('never re-pins a chat whose project was removed', async () => {
    await inWorkspace(() => addProject(one));
    await inWorkspace(() => addProject(two));
    await inWorkspace(() => bindChatProject('chat-2', two));
    await inWorkspace(() => removeProject(two));
    await inWorkspace(() => setActiveProject(one));
    await expect(inWorkspace(loadProjectState)).resolves.toEqual({ projects: [one], activeProject: one });
    await expect(inWorkspace(() => getChatProject('chat-2'))).resolves.toBeUndefined();
    // Bound before: no folder at all rather than silently moving to `one`.
    await expect(inWorkspace(() => resolveConversationProjectDir('chat-2'))).resolves.toBeUndefined();
    await expect(fs.stat(two)).resolves.toBeTruthy();

    // Re-adding the project revives the chat's binding.
    await inWorkspace(() => addProject(two));
    await expect(inWorkspace(() => resolveConversationProjectDir('chat-2'))).resolves.toBe(two);
  });

  it('keeps the data directory default until a project is explicitly chosen', async () => {
    // Folders configured through the workspace editor do not become active implicitly.
    await updateWorkspaceRoots('side', [one, two]);
    await expect(inWorkspace(loadProjectState)).resolves.toEqual({ projects: [one, two], activeProject: undefined });
    await expect(inWorkspace(() => resolveConversationProjectDir('chat-1'))).resolves.toBeUndefined();
    expect((await listWorkspaces()).find(w => w.name === 'side')?.activeProject).toBeUndefined();
  });

  it('runs subflow lanes in their root chat folder without binding each lane', async () => {
    await inWorkspace(() => addProject(one));
    await inWorkspace(() => addProject(two));
    const worktree = path.join(dataRoot, 'code', 'one.worktrees', 'feat');
    await fs.mkdir(worktree, { recursive: true });
    await inWorkspace(() => bindChatProject('root-chat', one, worktree));
    const states = await inWorkspace(async () => getConversationStates());
    states.set('lane-1', { conversationId: 'lane-1', rootConversationId: 'root-chat' } as unknown as SharedState);
    try {
      // The sidebar selects `two`, but the lane works where its chat works.
      await expect(inWorkspace(() => resolveConversationProjectDir('lane-1'))).resolves.toBe(worktree);
      expect(Object.keys((await readWorkspaceMetadata('side')).chatProjects as object)).toEqual(['root-chat']);
    } finally {
      states.delete('lane-1');
    }
  });

  it('never lets a first-use pin overwrite a binding chosen meanwhile', async () => {
    await inWorkspace(() => addProject(one));
    await inWorkspace(() => addProject(two));
    // The user's choice and the agent's first tool call race for the same chat.
    const [, resolved] = await Promise.all([
      inWorkspace(() => bindChatProject('chat-1', one)),
      inWorkspace(() => resolveConversationProjectDir('chat-1')),
    ]);
    await expect(inWorkspace(() => getChatProject('chat-1'))).resolves.toEqual({ project: one, path: one });
    expect(resolved).toBe(one);
  });

  it('lets a workspace save repair an unreadable metadata file', async () => {
    const metadataPath = path.join(dataRoot, 'workspaces', 'side', '.workspace.json');
    await fs.writeFile(metadataPath, '{"roots": [', 'utf8');
    await updateWorkspaceRoots('side', [one]);
    await expect(readWorkspaceMetadata('side')).resolves.toEqual({ roots: [one] });
  });

  it('serializes concurrent metadata writes without losing updates', async () => {
    await inWorkspace(() => addProject(one));
    await Promise.all(Array.from({ length: 12 }, (_, index) => inWorkspace(() => bindChatProject(`chat-${index}`, one))));
    const metadata = await readWorkspaceMetadata('side');
    expect(Object.keys(metadata.chatProjects as object)).toHaveLength(12);
  });

  it('exposes the active project first plus existing worktree folders as roots', async () => {
    await inWorkspace(() => addProject(one));
    await inWorkspace(() => addProject(two));
    await fs.mkdir(path.join(dataRoot, 'code', 'one.worktrees'));
    await expect(inWorkspace(loadWorkspaceProjectRoots)).resolves.toEqual([
      two,
      one,
      path.join(dataRoot, 'code', 'one.worktrees'),
    ]);
  });

  it('sends the chat folder only to the local shipped bash and filesystem servers', async () => {
    await inWorkspace(() => addProject(one));
    const shipped = (internalPackage: string, extra: Partial<MCPServerConfig> = {}) => ({
      name: 'x', transport: 'stdio', command: 'node', args: [], env: {}, internalPackage, ...extra,
    }) as unknown as MCPServerConfig;
    await expect(inWorkspace(() => projectDirForToolCall(shipped('@mario.andreschak/mcp-bash'), 'c'))).resolves.toBe(one);
    await expect(inWorkspace(() => projectDirForToolCall(shipped('@mario.andreschak/mcp-flujo'), 'c'))).resolves.toBeUndefined();
    await expect(inWorkspace(() => projectDirForToolCall(
      shipped('@mario.andreschak/mcp-bash', { isolation: {} } as Partial<MCPServerConfig>), 'c',
    ))).resolves.toBeUndefined();
    await expect(inWorkspace(() => projectDirForToolCall(null, 'c'))).resolves.toBeUndefined();
  });
});
