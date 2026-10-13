import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return { ...actual, saveItem: jest.fn((...args: unknown[]) => actual.saveItem(...args)) };
});

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: {
  loadServerConfigs: (...args: unknown[]) => jest.requireActual('@/backend/services/mcp/config').loadServerConfigs(...args),
  notifyAllRootsChanged: jest.fn(),
  startEnabledServers: jest.fn(() => { throw new Error('Workspace creation must not start processes'); }),
} }));
jest.mock('@/backend/init', () => ({
  ensureWorkspaceInitialized: jest.fn(() => { throw new Error('Workspace creation must not initialize runtime services'); }),
}));

import { POST } from '@/app/api/workspaces/route';
import { GET as getServers } from '@/app/api/mcp/servers/route';
import { mcpService } from '@/backend/services/mcp';
import { ensureWorkspaceInitialized } from '@/backend/init';
import { SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import { StorageKey } from '@/shared/types/storage';
import * as storage from '@/utils/storage/backend';
import { ensureWorkspaceDirs, getCurrentWorkspace, getWorkspaceDir, runWithWorkspace } from '@/utils/workspace';
import { installBundledFixtureOwner } from '../mcp/fixtures/bundledFixtureOwner';

describe('API workspace creation provisions independent shipped MCP records', () => {
  let fixture: string;
  let saved: Record<string, string | undefined>;
  let owner: ReturnType<typeof installBundledFixtureOwner>;
  const write = async (relative: string, content: string) => {
    const file = path.join(process.env.FLUJO_APP_ROOT!, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const recordFile = (name: string, key: StorageKey) => path.join(getWorkspaceDir(name), 'db', `${key}.json`);
  const request = (url: string, name?: string) => new Request(url, {
    ...(name ? { method: 'POST', body: JSON.stringify({ name }) } : {}),
    headers: owner.request('filesystem').headers,
  });
  const create = (name: string) => POST(request('http://localhost:4200/api/workspaces', name));
  const list = (name: string) => getServers(request(`http://localhost:4200/api/mcp/servers?workspace=${name}`));

  beforeEach(async () => {
    jest.clearAllMocks();
    saved = Object.fromEntries(['FLUJO_APP_ROOT', 'FLUJO_DATA_DIR', 'FLUJO_TEST_PRIVATE_SECRET'].map(key => [key, process.env[key]]));
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-api-workspace-'));
    process.env.FLUJO_APP_ROOT = path.join(fixture, 'application');
    process.env.FLUJO_DATA_DIR = path.join(fixture, 'data');
    process.env.FLUJO_TEST_PRIVATE_SECRET = 'host-secret-must-not-copy';
    await write('node_modules/fixture-dependency/package.json', JSON.stringify({ name: 'fixture-dependency', type: 'module', exports: './index.js' }));
    await write('node_modules/fixture-dependency/index.js', 'export const value = 1;');
    for (const descriptor of SHIPPED_MCP_SERVERS) {
      const prefix = `mcp-servers/${descriptor.packageDirectory}`;
      await write(`${prefix}/package.json`, JSON.stringify({ name: descriptor.packageId, type: 'module', dependencies: { 'fixture-dependency': '1.0.0' } }));
      await write(`${prefix}/dist/index.js`, 'export { value } from "fixture-dependency";');
      await write(`${prefix}/src/index.ts`, 'export const source = true;');
      await write(`${prefix}/userdata/private.txt`, 'template-runtime-secret');
    }
    await write('mcp-servers/shared/package.json', '{"name":"@flujo-ai/mcp-shared","type":"module"}');
    await write('mcp-servers/shared/src/index.ts', 'export {};');
    await write('mcp-servers/embed-shared.mjs', '// helper');
    await ensureWorkspaceDirs('default-workspace');
    owner = installBundledFixtureOwner();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    owner?.restore();
    await fs.rm(fixture, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('returns all real persisted defaults immediately after POST, without initializing or starting services', async () => {
    expect((await create('first-agent')).status).toBe(201);
    const response = await list('first-agent');
    expect(response.status).toBe(200);
    const records = await response.json();
    expect(records.map((record: { name: string }) => record.name).sort()).toEqual(SHIPPED_MCP_SERVERS.map(descriptor => descriptor.defaultName).sort());
    const persisted = JSON.parse(await fs.readFile(recordFile('first-agent', StorageKey.MCP_SERVERS), 'utf8'));
    for (const descriptor of SHIPPED_MCP_SERVERS) {
      expect(persisted[descriptor.defaultName]).toMatchObject({
        command: 'node', rootPath: path.join('mcp-servers', descriptor.packageDirectory),
        env: { FLUJO_WORKSPACE: 'first-agent', FLUJO_DATA_DIR: getWorkspaceDir('first-agent') },
      });
      expect(persisted[descriptor.defaultName].env).not.toHaveProperty('FLUJO_TEST_PRIVATE_SECRET');
      await expect(fs.stat(path.join(getWorkspaceDir('first-agent'), 'mcp-servers', descriptor.packageDirectory, 'dist/index.js'))).resolves.toBeDefined();
      await expect(fs.stat(path.join(getWorkspaceDir('first-agent'), 'mcp-servers', descriptor.packageDirectory, 'userdata'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(ensureWorkspaceInitialized).not.toHaveBeenCalled();
    expect(mcpService.startEnabledServers).not.toHaveBeenCalled();
  });

  it('keeps caller selection and default credentials isolated across two newly created workspaces', async () => {
    const defaults = { privateRemote: { transport: 'streamable', url: 'https://example.invalid', headers: { Authorization: 'owner-secret-sentinel' } } };
    await runWithWorkspace('default-workspace', () => storage.saveItem(StorageKey.MCP_SERVERS, defaults));
    const original = await fs.readFile(recordFile('default-workspace', StorageKey.MCP_SERVERS), 'utf8');
    await runWithWorkspace('default-workspace', async () => {
      expect((await create('alpha')).status).toBe(201);
      expect(getCurrentWorkspace()).toBe('default-workspace');
      expect((await create('beta')).status).toBe(201);
      expect(getCurrentWorkspace()).toBe('default-workspace');
    });
    for (const name of ['alpha', 'beta']) {
      const response = await list(name);
      expect(response.status).toBe(200);
      const records = await response.json();
      expect(records).toHaveLength(SHIPPED_MCP_SERVERS.length);
      expect(JSON.stringify(records)).not.toContain('owner-secret-sentinel');
      expect(records.every((record: { env: { FLUJO_WORKSPACE: string } }) => record.env.FLUJO_WORKSPACE === name)).toBe(true);
    }
    await expect(fs.readFile(recordFile('default-workspace', StorageKey.MCP_SERVERS), 'utf8')).resolves.toBe(original);
    expect((await fs.readdir(path.join(getWorkspaceDir('alpha'), 'db'))).some(name => /owner|credential|approval/i.test(name))).toBe(false);
  });

  it('rolls back partial marker publication and can retry the same name without touching another workspace', async () => {
    await runWithWorkspace('default-workspace', () => storage.saveItem(StorageKey.MCP_SERVERS, { sentinel: { disabled: true } }));
    const original = await fs.readFile(recordFile('default-workspace', StorageKey.MCP_SERVERS), 'utf8');
    const save = jest.requireActual<typeof import('@/utils/storage/backend')>('@/utils/storage/backend').saveItem;
    let rejected = false;
    jest.spyOn(storage, 'saveItem').mockImplementation(async (key, value, assertCurrent) => {
      if (!rejected && getCurrentWorkspace() === 'retry-workspace' && key === StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1) {
        rejected = true;
        expect(JSON.parse(await fs.readFile(recordFile('retry-workspace', StorageKey.MCP_SERVERS), 'utf8'))).toHaveProperty('filesystem');
        throw new Error('injected marker publication failure');
      }
      return save(key, value, assertCurrent);
    });
    expect((await create('retry-workspace')).status).toBe(500);
    expect(rejected).toBe(true);
    await expect(fs.stat(getWorkspaceDir('retry-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(recordFile('default-workspace', StorageKey.MCP_SERVERS), 'utf8')).resolves.toBe(original);
    expect((await create('retry-workspace')).status).toBe(201);
    expect((await (await list('retry-workspace')).json())).toHaveLength(SHIPPED_MCP_SERVERS.length);
  });
});
