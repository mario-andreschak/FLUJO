import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRootsListHandler, setNodeRoots, _resetNodeRootsForTests } from '@/backend/services/mcp/roots';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { loadItem } from '@/utils/storage/backend';
import { DEFAULT_WORKSPACE, ensureWorkspaceDirs, updateWorkspaceRoots } from '@/utils/workspace';
import { confineFilesystemPath } from '../../mcp-servers/filesystem/src/pathConfinement';
import type { MCPServerConfig } from '@/shared/types/mcp';

jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn() }));
jest.mock('@/backend/utils/resolveGlobalVars', () => ({ resolveGlobalVars: jest.fn(async value => value) }));

let directory: string;
let outside: string;
let workspaceRoot: string;
let config: MCPServerConfig;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = { FLUJO_DATA_DIR: process.env.FLUJO_DATA_DIR, FLUJO_FS_ROOTS: process.env.FLUJO_FS_ROOTS };
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-roots-setting-'));
  process.env.FLUJO_DATA_DIR = directory;
  delete process.env.FLUJO_FS_ROOTS;
  workspaceRoot = path.join(directory, 'project');
  outside = path.join(directory, 'outside-project', 'session.jsonl');
  await fs.mkdir(path.dirname(outside), { recursive: true });
  await fs.writeFile(outside, 'fixture session');
  await fs.mkdir(workspaceRoot);
  await ensureWorkspaceDirs(DEFAULT_WORKSPACE);
  await updateWorkspaceRoots(DEFAULT_WORKSPACE, [workspaceRoot]);
  config = { name: 'roots-fixture', transport: 'streamable', serverUrl: 'https://example.invalid',
    rootPath: workspaceRoot, roots: [workspaceRoot], env: {}, disabled: false,
    _buildCommand: '', _installCommand: '' };
  jest.mocked(loadServerConfigs).mockResolvedValue([config]);
  _resetNodeRootsForTests();
  setNodeRoots(config.name, 'fixture-node', [workspaceRoot]);
});

afterEach(async () => {
  _resetNodeRootsForTests();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(directory, { recursive: true, force: true });
});

test.each([undefined, false])('restriction %s allows a file outside workspace, server and node roots', async setting => {
  jest.mocked(loadItem).mockResolvedValue({ experimental: { restrictMcpFilesystemToRoots: setting } });
  const result = await createRootsListHandler(config)();
  const roots = result.roots.map(root => fileURLToPath(root.uri));
  expect(await confineFilesystemPath(outside, roots)).toBe(outside);
  expect(await fs.readFile(outside, 'utf8')).toBe('fixture session');
});

test('restriction on denies the same outside file and advertises the configured project root', async () => {
  jest.mocked(loadItem).mockResolvedValue({ experimental: { restrictMcpFilesystemToRoots: true } });
  const result = await createRootsListHandler(config)();
  expect(result.roots.map(root => root.uri)).toEqual([pathToFileURL(workspaceRoot).href]);
  await expect(confineFilesystemPath(outside, result.roots.map(root => fileURLToPath(root.uri))))
    .rejects.toThrow('outside the configured filesystem roots');
});

test('a connected handler reads the changed restriction setting on its next request', async () => {
  const handler = createRootsListHandler(config);
  jest.mocked(loadItem).mockResolvedValue({ experimental: { restrictMcpFilesystemToRoots: true } });
  expect((await handler()).roots.map(root => root.uri)).toEqual([pathToFileURL(workspaceRoot).href]);
  jest.mocked(loadItem).mockResolvedValue({ experimental: { restrictMcpFilesystemToRoots: false } });
  const result = await handler();
  expect(await confineFilesystemPath(outside, result.roots.map(root => fileURLToPath(root.uri)))).toBe(outside);
});

test('an operator environment ceiling still applies with restriction off', async () => {
  jest.mocked(loadItem).mockResolvedValue({ experimental: { restrictMcpFilesystemToRoots: false } });
  process.env.FLUJO_FS_ROOTS = workspaceRoot;
  const result = await createRootsListHandler(config)();
  await expect(confineFilesystemPath(outside, result.roots.map(root => fileURLToPath(root.uri))))
    .rejects.toThrow('outside the configured filesystem roots');
});
