import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCPService } from '@/backend/services/mcp';
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import { ensureShippedWorkspacePackages } from '@/backend/services/mcp/shippedWorkspacePackages';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import type { MCPServerConfig } from '@/shared/types/mcp';

// Exercise the actual save -> managed-root -> connect order. Persistence and
// the process spawn are replaced; package copy and directory guards are real.
const records = new Map<string, MCPServerConfig>();
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: async () => [...records.values()],
  saveConfig: async (configs: Map<string, MCPServerConfig>) => {
    records.clear();
    for (const [name, config] of configs) records.set(name, config);
    return { success: true };
  },
}));

describe('saving a shipped stdio config before its first connection', () => {
  let fixture: string;
  let application: string;
  let workspace: string;
  let service: MCPService;
  let previousData: string | undefined;
  let previousApp: string | undefined;
  const descriptor = SHIPPED_MCP_SERVERS.find(server => server.packageDirectory === 'flujo')!;
  const write = async (relative: string, value: string) => {
    const filename = path.join(application, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, value);
  };
  const config = () => ({ ...createShippedServerConfig(descriptor), env: {} });

  beforeEach(async () => {
    records.clear();
    previousData = process.env.FLUJO_DATA_DIR;
    previousApp = process.env.FLUJO_APP_ROOT;
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-shipped-save-'));
    application = path.join(fixture, 'application');
    process.env.FLUJO_DATA_DIR = path.join(fixture, 'data');
    process.env.FLUJO_APP_ROOT = application;
    await write('mcp-servers/flujo/package.json', JSON.stringify({ name: descriptor.packageId, type: 'module' }));
    await write('mcp-servers/flujo/dist/index.js', 'export const value = "shipped-template";');
    await write('mcp-servers/shared/package.json', '{"name":"@flujo-ai/mcp-shared","type":"module"}');
    workspace = runWithWorkspace('first-install', () => getWorkspaceDataDir());
    // A restored worker workspace can exist before shipped package copies.
    await fs.mkdir(workspace, { recursive: true });
    service = new MCPService();
    global.__mcp_clients?.clear();
    global.__mcp_active_transports?.clear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (previousData === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousData;
    if (previousApp === undefined) delete process.env.FLUJO_APP_ROOT;
    else process.env.FLUJO_APP_ROOT = previousApp;
    await fs.rm(fixture, { recursive: true, force: true });
  });

  test('the first connection materializes the shipped package after config save', async () => {
    const connect = jest.spyOn(service, 'connectServer').mockImplementation(async () => {
      // This is the same copy performed by attachShippedWorkspaceReadiness
      // immediately before the SDK starts its child process.
      await ensureShippedWorkspacePackages(workspace, application, ['flujo']);
      return { success: true };
    });
    const result = await runWithWorkspace('first-install', () => service.updateServerConfig('flujo', config()));
    expect(result).toMatchObject({ name: 'flujo' });
    expect(records.has('flujo')).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(workspace, 'mcp-servers/flujo/dist/index.js'), 'utf8'))
      .resolves.toBe('export const value = "shipped-template";');
    await expect(fs.readFile(path.join(application, 'mcp-servers/flujo/dist/index.js'), 'utf8'))
      .resolves.toBe('export const value = "shipped-template";');
  });

  test('ordinary marketplace records still receive their managed roots', async () => {
    const ordinary = { ...config(), name: 'ordinary-package', rootPath: 'mcp-servers/ordinary-package',
      cwd: 'mcp-servers/ordinary-package', disabled: true,
      source: { type: 'marketplace' as const, id: '@example/ordinary-package' } };
    await runWithWorkspace('first-install', () => service.updateServerConfig(ordinary.name, ordinary));
    expect((await fs.stat(path.join(workspace, ordinary.rootPath))).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(workspace, 'mcp-servers/flujo'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each([false, true])('preserves and rejects an existing reserved directory (nonempty=%s)', async nonempty => {
    const destination = path.join(workspace, 'mcp-servers/flujo');
    await fs.mkdir(destination, { recursive: true });
    if (nonempty) await fs.writeFile(path.join(destination, 'owner.txt'), 'preserve this directory');
    const copyErrors: string[] = [];
    jest.spyOn(service, 'connectServer').mockImplementation(async () => {
      try { await ensureShippedWorkspacePackages(workspace, application, ['flujo']); }
      catch (error) { copyErrors.push((error as Error).message); return { success: false }; }
      return { success: true };
    });
    await runWithWorkspace('first-install', () => service.updateServerConfig('flujo', config()));
    expect(copyErrors).toEqual(['Shipped package manifest is missing: flujo']);
    await expect(fs.stat(path.join(destination, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(destination)).toEqual(nonempty ? ['owner.txt'] : []);
    if (nonempty) await expect(fs.readFile(path.join(destination, 'owner.txt'), 'utf8')).resolves.toBe('preserve this directory');
  });
});
