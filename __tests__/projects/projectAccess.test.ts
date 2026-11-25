import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('@/backend/services/mcp/roots', () => ({ loadMcpRootsRestriction: jest.fn(async () => false) }));

import { loadMcpRootsRestriction } from '@/backend/services/mcp/roots';
import { createWorkspace, runWithWorkspace } from '@/utils/workspace';
import { addProject } from '@/backend/services/projects/projectStore';
import { assertAgentsCanWorkIn, chatFolderUse } from '@/backend/services/projects/projectAccess';

const restricted = loadMcpRootsRestriction as jest.MockedFunction<typeof loadMcpRootsRestriction>;

describe('whether agents can work in a chat folder', () => {
  let dataRoot: string;
  let priorDataDir: string | undefined;
  let project: string;
  let ownWorktree: string;
  let otherWorktree: string;
  const inWorkspace = <T>(fn: () => Promise<T>) => runWithWorkspace('side', fn);

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-project-access-'));
    process.env.FLUJO_DATA_DIR = dataRoot;
    project = path.join(dataRoot, 'code', 'app');
    ownWorktree = path.join(dataRoot, 'code', 'app.worktrees', 'feat');
    otherWorktree = path.join(dataRoot, 'elsewhere', 'agent-run');
    await Promise.all([project, ownWorktree, otherWorktree].map(folder => fs.mkdir(folder, { recursive: true })));
    await createWorkspace('side');
    await inWorkspace(() => addProject(project));
    restricted.mockResolvedValue(false);
  });

  afterEach(async () => {
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  it('allows any folder while folder restrictions are off', async () => {
    await expect(inWorkspace(() => assertAgentsCanWorkIn(otherWorktree))).resolves.toBeUndefined();
    await expect(inWorkspace(() => chatFolderUse(otherWorktree))).resolves.toEqual({ missing: false, agentsCanWork: true });
  });

  it('refuses a worktree outside the projects while folder restrictions are on, saying how to fix it', async () => {
    restricted.mockResolvedValue(true);
    await expect(inWorkspace(() => assertAgentsCanWorkIn(project))).resolves.toBeUndefined();
    await expect(inWorkspace(() => assertAgentsCanWorkIn(ownWorktree))).resolves.toBeUndefined();
    await expect(inWorkspace(() => assertAgentsCanWorkIn(otherWorktree))).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID_ROOTS',
      message: expect.stringMatching(/Restrict MCP filesystem access to configured roots.*Add it as a project/),
    });
  });

  it('flags a chat folder the agents cannot use, so the chip can warn', async () => {
    restricted.mockResolvedValue(true);
    await expect(inWorkspace(() => chatFolderUse(otherWorktree))).resolves.toEqual({ missing: false, agentsCanWork: false });
    await expect(inWorkspace(() => chatFolderUse(ownWorktree))).resolves.toEqual({ missing: false, agentsCanWork: true });
  });

  it('flags a project folder that was deleted or whose drive is gone', async () => {
    await fs.rm(project, { recursive: true });
    await expect(inWorkspace(() => chatFolderUse(project))).resolves.toEqual({ missing: true, agentsCanWork: true });
  });
});
