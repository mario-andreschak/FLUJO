/**
 * Deleting an MCP bundle server (#1230) through the real route and MCP service
 * also removes its unpacked files; other servers' folders are left alone.
 */
import fs from 'fs/promises';
import path from 'path';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';
import { installPrivateProfileFixture } from '../utils/privateProfileFixture';

jest.mock('@/backend/utils/resolveDynamicReferences', () => ({
  resolvePromptDynamicReferences: jest.fn(async (value: unknown) => value),
  resolvePresetArguments: jest.fn(async (value: unknown) => value),
  applyPresetArguments: jest.fn(async (value: unknown) => value),
}));
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    migrateMcpServerReferences: jest.fn(async () => ({ success: true, migratedFlows: 0, migratedReferences: 0 })),
    loadFlows: async () => [],
  },
}));
const store: Record<string, unknown> = {};
jest.mock('@/utils/storage/backend', () => ({
  // No Personas: deleting a server looks for Personas that use it.
  listCollectionItems: jest.fn(async () => []),
  saveItem: jest.fn(async (key: string, value: unknown) => { store[key] = value; }),
  loadItem: jest.fn(async (key: string, fallback: unknown) => (key in store ? store[key] : fallback)),
}));
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (value: unknown) => value),
}));

import { POST as createServer } from '@/app/api/mcp/servers/route';
import { DELETE as deleteServer } from '@/app/api/mcp/servers/[name]/route';
import { mcpbInstallDir } from '@/backend/services/mcp/mcpb/files';
import { _resetLifecycleForTests } from '@/backend/services/mcp/lifecycleCoordinator';
import { makeLocalRequest } from '../utils/localRequest';

let privateFixture: Awaited<ReturnType<typeof installPrivateProfileFixture>> | undefined;

const server = (name: string, rootPath: string, source: MCPServerConfig['source']): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'node',
  args: [`${rootPath}/server/index.js`],
  env: {},
  disabled: true,
  rootPath,
  _buildCommand: '',
  _installCommand: '',
  source,
} as MCPStdioConfig);

beforeEach(async () => {
  _resetLifecycleForTests();
  for (const key of Object.keys(store)) delete store[key];
  privateFixture = await installPrivateProfileFixture((metadata) => { store.encryption_key = metadata; });
});

afterEach(async () => {
  await privateFixture?.restore();
});

it('removes a deleted bundle server\'s folder, but not a hand-made server\'s folder', async () => {
  const bundleDir = mcpbInstallDir('hello');
  const handMadeDir = mcpbInstallDir('hand-made');
  for (const dir of [bundleDir, handMadeDir]) {
    await fs.mkdir(path.join(dir, 'server'), { recursive: true });
    await fs.writeFile(path.join(dir, 'server', 'index.js'), 'console.log(1)');
  }

  const created = await createServer(makeLocalRequest({ body: server('hello', bundleDir, { type: 'mcpb', bundleName: 'hello', version: '1.0.0', digest: 'd' }) }));
  expect(created.status).toBe(201);
  expect(await createServer(makeLocalRequest({ body: server('hand-made', handMadeDir, { type: 'local' }) }))).toHaveProperty('status', 201);

  const removed = await deleteServer(makeLocalRequest(), { params: Promise.resolve({ name: 'hello' }) });
  expect(removed.status).toBe(200);
  await expect(fs.access(bundleDir)).rejects.toThrow();

  const kept = await deleteServer(makeLocalRequest(), { params: Promise.resolve({ name: 'hand-made' }) });
  expect(kept.status).toBe(200);
  await expect(fs.access(path.join(handMadeDir, 'server', 'index.js'))).resolves.toBeUndefined();
});
