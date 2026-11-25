import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return { ...actual, writeFileAtomic: jest.fn(actual.writeFileAtomic) };
});

import { writeFileAtomic } from '@/utils/storage/backend';
import { createWorkspace, readWorkspaceMetadata, runWithWorkspace } from '@/utils/workspace';
import {
  _settleChatProjectMigrationForTests,
  migrateLegacyChatProjects,
} from '@/backend/services/projects/chatProjectBindings';
import { getChatProject, resolveConversationProjectDir } from '@/backend/services/projects/projectStore';

const mockedWrite = writeFileAtomic as jest.MockedFunction<typeof writeFileAtomic>;

describe('moving chat folders out of the shared workspace file', () => {
  let dataRoot: string;
  let priorDataDir: string | undefined;
  let one: string;
  let two: string;
  const inWorkspace = <T>(fn: () => Promise<T>) => runWithWorkspace('side', fn);
  const workspaceDir = () => path.join(dataRoot, 'workspaces', 'side');
  const metadataFile = () => path.join(workspaceDir(), '.workspace.json');
  const backupFile = () => path.join(workspaceDir(), '.workspace.chat-projects.backup.json');
  const bindingFile = (id: string) => path.join(workspaceDir(), 'db', 'chat-projects', `${id}.json`);

  /** A workspace as an older FLUJO left it: every chat's folder in `.workspace.json`. */
  async function seedLegacy(chatProjects: Record<string, unknown>, existingChats: string[]) {
    const metadata = { roots: [one, two], activeProject: two, chatProjects };
    await fs.writeFile(metadataFile(), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    const conversations = path.join(workspaceDir(), 'db', 'conversations');
    await fs.mkdir(conversations, { recursive: true });
    await Promise.all(existingChats.map(id =>
      fs.writeFile(path.join(conversations, `${id}.json`), JSON.stringify({ conversationId: id }), 'utf8')));
  }

  async function readJson(file: string): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  }

  beforeEach(async () => {
    priorDataDir = process.env.FLUJO_DATA_DIR;
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-chat-projects-'));
    process.env.FLUJO_DATA_DIR = dataRoot;
    one = path.join(dataRoot, 'code', 'one');
    two = path.join(dataRoot, 'code', 'two');
    await fs.mkdir(one, { recursive: true });
    await fs.mkdir(two, { recursive: true });
    await createWorkspace('side');
  });

  afterEach(async () => {
    await inWorkspace(_settleChatProjectMigrationForTests);
    mockedWrite.mockClear();
    if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = priorDataDir;
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  it('moves every entry into its chat, keeps a backup and drops entries of deleted chats', async () => {
    const legacy = {
      'chat-a': { project: one, path: one, at: 1 },
      'chat-b': { project: two, path: two, at: 2 },
      'deleted-chat': { project: one, path: one, at: 3 },
      'not.a.chat': { project: one, path: one, at: 4 },
    };
    await seedLegacy(legacy, ['chat-a', 'chat-b']);

    await expect(inWorkspace(migrateLegacyChatProjects)).resolves.toEqual({ moved: 2, alreadyMoved: 0, dropped: 2, remaining: 0 });

    const metadata = await readWorkspaceMetadata('side');
    expect(metadata).toEqual({ roots: [one, two], activeProject: two });
    expect(await readJson(bindingFile('chat-a'))).toMatchObject({ project: one, path: one });
    expect(await readJson(bindingFile('chat-b'))).toMatchObject({ project: two, path: two });
    await expect(fs.stat(bindingFile('deleted-chat'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readJson(backupFile())).chatProjects).toEqual(legacy);
    await expect(inWorkspace(() => getChatProject('chat-a'))).resolves.toEqual({ project: one, path: one });

    // Running it again finds nothing to do.
    await expect(inWorkspace(migrateLegacyChatProjects)).resolves.toEqual({ moved: 0, alreadyMoved: 0, dropped: 0, remaining: 0 });
  });

  it('finishes the move after a crash halfway, keeping choices made since', async () => {
    const legacy = {
      'chat-a': { project: one, path: one, at: 1 },
      'chat-b': { project: one, path: one, at: 2 },
      'chat-c': { project: one, path: one, at: 3 },
    };
    await seedLegacy(legacy, ['chat-a', 'chat-b', 'chat-c']);
    // The crash: chat-a's file was written, then FLUJO stopped before the old
    // map was cleaned up. Afterwards the user moved chat-b to another project.
    await fs.mkdir(path.dirname(bindingFile('chat-a')), { recursive: true });
    await fs.writeFile(bindingFile('chat-a'), JSON.stringify({ version: 1, project: one, path: one }), 'utf8');
    await fs.writeFile(bindingFile('chat-b'), JSON.stringify({ version: 1, project: two, path: two }), 'utf8');

    // Until the move finishes, the old map still answers for chat-c.
    await expect(inWorkspace(() => getChatProject('chat-c'))).resolves.toEqual({ project: one, path: one });
    await inWorkspace(_settleChatProjectMigrationForTests);

    await inWorkspace(migrateLegacyChatProjects);
    expect(await readWorkspaceMetadata('side')).not.toHaveProperty('chatProjects');
    await expect(inWorkspace(() => getChatProject('chat-a'))).resolves.toEqual({ project: one, path: one });
    await expect(inWorkspace(() => getChatProject('chat-b'))).resolves.toEqual({ project: two, path: two });
    await expect(inWorkspace(() => getChatProject('chat-c'))).resolves.toEqual({ project: one, path: one });
    expect((await readJson(backupFile())).chatProjects).toEqual(legacy);
  });

  it('leaves an entry it could not move in the old map, readable, and moves it on the next try', async () => {
    const legacy = {
      'chat-a': { project: one, path: one, at: 1 },
      'chat-b': { project: two, path: two, at: 2 },
      'chat-c': { project: one, path: one, at: 3 },
    };
    await seedLegacy(legacy, ['chat-a', 'chat-b', 'chat-c']);
    const actual = jest.requireActual('@/utils/storage/backend') as typeof import('@/utils/storage/backend');
    mockedWrite.mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith(`${path.sep}chat-b.json`)) throw Object.assign(new Error('disk is busy'), { code: 'EIO' });
      return actual.writeFileAtomic(file, ...rest);
    });

    await expect(inWorkspace(migrateLegacyChatProjects)).rejects.toThrow(/could not be moved yet/);
    expect((await readWorkspaceMetadata('side')).chatProjects).toEqual({ 'chat-b': legacy['chat-b'] });
    await expect(inWorkspace(() => getChatProject('chat-b'))).resolves.toEqual({ project: two, path: two });
    await inWorkspace(_settleChatProjectMigrationForTests);

    mockedWrite.mockImplementation(actual.writeFileAtomic);
    await expect(inWorkspace(migrateLegacyChatProjects)).resolves.toMatchObject({ moved: 1, remaining: 0 });
    expect(await readWorkspaceMetadata('side')).not.toHaveProperty('chatProjects');
    await expect(inWorkspace(() => getChatProject('chat-b'))).resolves.toEqual({ project: two, path: two });
    expect((await readJson(backupFile())).chatProjects).toEqual(legacy);
  });

  it('never pins a chat that still waits in the old map to the active project', async () => {
    await seedLegacy({ 'chat-a': { project: one, path: one, at: 1 } }, ['chat-a']);
    // The sidebar selects `two`, but the chat keeps `one` from the old map.
    await expect(inWorkspace(() => resolveConversationProjectDir('chat-a'))).resolves.toBe(one);
    await inWorkspace(_settleChatProjectMigrationForTests);
    await expect(inWorkspace(() => resolveConversationProjectDir('chat-a'))).resolves.toBe(one);
    expect(await readWorkspaceMetadata('side')).not.toHaveProperty('chatProjects');
  });

  it('moves more than 2000 chats, the old limit', async () => {
    const ids = Array.from({ length: 2001 }, (_, index) => `chat-${index}`);
    await seedLegacy(Object.fromEntries(ids.map(id => [id, { project: one, path: one, at: 0 }])), ids);
    await expect(inWorkspace(migrateLegacyChatProjects)).resolves.toMatchObject({ moved: 2001, remaining: 0 });
    const stored = (await fs.readdir(path.join(workspaceDir(), 'db', 'chat-projects'))).filter(file => file.endsWith('.json'));
    expect(stored).toHaveLength(2001);
    await expect(inWorkspace(() => getChatProject('chat-2000'))).resolves.toEqual({ project: one, path: one });
  }, 120_000);
});
