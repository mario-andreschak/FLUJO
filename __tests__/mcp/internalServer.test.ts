/** Ordinary persisted-config and CRUD coverage for shipped MCP packages. */

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

jest.mock('@/utils/logger', () => {
  const log = jest.fn();
  return {
    ...jest.requireActual('@/utils/logger'),
    __testLog: log,
    createLogger: () => ({ debug: log, verbose: log, info: log, warn: log, error: log }),
  };
});

import path from 'node:path';
import { mcpService } from '@/backend/services/mcp';
import { resolveStdioLaunch } from '@/backend/services/mcp/connection';
import {
  createShippedServerConfig,
  resolvePlaywrightBrowsersPath,
  shippedServerEnv,
  SHIPPED_MCP_SERVERS,
} from '@/backend/services/mcp/shippedServers';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';
import { ensureWorkspaceDirs } from '@/utils/workspace';

const loadItemMock = loadItem as jest.Mock;
const saveItemMock = saveItem as jest.Mock;
const logMock = jest.requireMock('@/utils/logger').__testLog as jest.Mock;
let storage: Map<StorageKey, unknown>;

beforeAll(async () => {
  await ensureWorkspaceDirs();
});

function copy<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? value : JSON.parse(serialized) as T;
}

function persisted(config: MCPServerConfig): Record<string, unknown> {
  const { name: _name, ...stored } = config;
  return stored;
}

beforeEach(() => {
  jest.clearAllMocks();
  storage = new Map([
    [StorageKey.MCP_SERVERS, Object.fromEntries(
      SHIPPED_MCP_SERVERS.map((descriptor) => [
        descriptor.defaultName,
        persisted({ ...createShippedServerConfig(descriptor), disabled: true }),
      ]),
    )],
  ]);
  loadItemMock.mockImplementation(async (key: StorageKey, fallback: unknown) =>
    storage.has(key) ? copy(storage.get(key)) : fallback
  );
  saveItemMock.mockImplementation(async (key: StorageKey, value: unknown) => {
    storage.set(key, copy(value));
  });
});

describe('persisted shipped server configs', () => {
  it('loads shipped packages only from ordinary MCP_SERVERS records', async () => {
    const configs = await mcpService.loadServerConfigs();
    expect(Array.isArray(configs)).toBe(true);
    const list = configs as MCPServerConfig[];

    for (const descriptor of SHIPPED_MCP_SERVERS) {
      const config = list.find((candidate) => candidate.name === descriptor.defaultName);
      expect(config).toMatchObject({
        transport: 'stdio',
        command: 'node',
        disabled: true,
        exposeAsMcpServer: true,
        enableMcpApps: descriptor.enableMcpApps ?? false,
      });
      expect(config).not.toHaveProperty('builtIn');
      expect(config).not.toHaveProperty('internalPackage');
      expect(config).not.toHaveProperty('packageCapabilities');
    }
  });

  it('renames a shipped record through the ordinary update path', async () => {
    const original = (await mcpService.loadServerConfigs() as MCPServerConfig[])
      .find((config) => config.name === 'filesystem');
    expect(original).toBeDefined();
    if (!original || original.transport !== 'stdio') {
      throw new Error('Expected the shipped filesystem server to use stdio.');
    }
    const result = await mcpService.updateServerConfig('filesystem', {
      name: 'workspace-files',
      disabled: true,
    });
    expect(result).toMatchObject({
      name: 'workspace-files',
      command: original.command,
      args: original.args,
      source: original.source,
      hostPathAccess: original.hostPathAccess,
    });

    const saved = storage.get(StorageKey.MCP_SERVERS) as Record<string, unknown>;
    expect(saved.filesystem).toBeUndefined();
    expect(saved['workspace-files']).toBeDefined();
  });

  it('deletes a shipped record without synthesizing it again', async () => {
    const result = await mcpService.deleteServerConfig('filesystem');
    expect(result.success).toBe(true);

    const saved = storage.get(StorageKey.MCP_SERVERS) as Record<string, unknown>;
    expect(saved.filesystem).toBeUndefined();
    const reloaded = await mcpService.loadServerConfigs() as MCPServerConfig[];
    expect(reloaded.some((config) => config.name === 'filesystem')).toBe(false);
  });

  it('leaves a pre-existing same-name user configuration unchanged', async () => {
    const custom = { transport: 'stdio', command: 'custom-flujo', disabled: true };
    storage.set(StorageKey.MCP_SERVERS, { flujo: custom });

    const configs = await mcpService.loadServerConfigs() as MCPServerConfig[];
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ name: 'flujo', ...custom });
  });
});

describe('normal stdio delivery', () => {
  it.each([undefined, '1'])('never logs configured or resolved env values in worker mode %s', (workerMode) => {
    const priorMode = process.env.FLUJO_WORKER_MODE;
    try {
      if (workerMode === undefined) delete process.env.FLUJO_WORKER_MODE;
      else process.env.FLUJO_WORKER_MODE = workerMode;
      const config = {
        name: 'secret-env-test', transport: 'stdio', command: 'node', args: ['server.js'],
        rootPath: '.', disabled: false, _installCommand: '', _buildCommand: '',
        env: {
          TOKEN: { value: 'synthetic-wrapped-secret', metadata: { isSecret: true } },
          LEGACY_TOKEN: 'synthetic-legacy-secret',
        },
      } as MCPStdioConfig;
      const launch = resolveStdioLaunch(config);
      expect(launch.env.TOKEN).toBe('synthetic-wrapped-secret');
      expect(launch.env.LEGACY_TOKEN).toBe('synthetic-legacy-secret');
      const logs = JSON.stringify(logMock.mock.calls);
      expect(logs).toContain('TOKEN');
      expect(logs).not.toContain('synthetic-wrapped-secret');
      expect(logs).not.toContain('synthetic-legacy-secret');
    } finally {
      if (priorMode === undefined) delete process.env.FLUJO_WORKER_MODE;
      else process.env.FLUJO_WORKER_MODE = priorMode;
    }
  });

  it('resolves Patchright\'s installation-wide browser cache on supported platforms', () => {
    expect(resolvePlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: ' /shared/browsers ' }, 'linux'))
      .toBe('/shared/browsers');
    expect(resolvePlaywrightBrowsersPath({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, 'win32'))
      .toBe(path.win32.join('C:\\Users\\tester\\AppData\\Local', 'ms-playwright'));
    expect(resolvePlaywrightBrowsersPath({ USERPROFILE: 'C:\\Users\\fallback' }, 'win32'))
      .toBe(path.win32.join('C:\\Users\\fallback', 'AppData', 'Local', 'ms-playwright'));
    expect(resolvePlaywrightBrowsersPath({ HOME: '/Users/tester' }, 'darwin'))
      .toBe(path.posix.join('/Users/tester', 'Library', 'Caches', 'ms-playwright'));
    expect(resolvePlaywrightBrowsersPath({ XDG_CACHE_HOME: '/var/cache/tester' }, 'linux'))
      .toBe(path.posix.join('/var/cache/tester', 'ms-playwright'));
    expect(resolvePlaywrightBrowsersPath({ HOME: '/home/tester' }, 'linux'))
      .toBe(path.posix.join('/home/tester', '.cache', 'ms-playwright'));
  });

  it('persists direct package entrypoints and ordinary working directories', () => {
    for (const descriptor of SHIPPED_MCP_SERVERS) {
      const config = createShippedServerConfig(descriptor);
      expect(config.command).toBe('node');
      expect(config.args).toEqual([
        path.join(config.cwd!, 'mcp-servers', descriptor.packageDirectory, 'dist', 'index.js'),
      ]);
      expect(path.isAbsolute(config.cwd ?? '')).toBe(true);
      expect(config.rootPath).toBe(path.join(config.cwd!, 'mcp-servers', descriptor.packageDirectory));
      expect(path.isAbsolute(config.rootPath)).toBe(true);
      expect(path.isAbsolute(config.args?.[0] ?? '')).toBe(true);
      expect(config.source).toEqual({ type: 'marketplace', id: descriptor.packageId });
      expect(config.icons).toEqual(descriptor.icons);
      expect(config.roots).toEqual([]);
      expect(config.enableMcpApps).toBe(descriptor.enableMcpApps ?? false);
    }
  });

  it('uses the same launch resolver as an arbitrary stdio server', () => {
    const descriptor = SHIPPED_MCP_SERVERS.find((item) => item.defaultName === 'flujo')!;
    const config = createShippedServerConfig(descriptor);
    const launch = resolveStdioLaunch(config);
    expect(launch.cwd).toBe(config.rootPath);
    expect(launch.args).toEqual(config.args);
  });

  it('adds the worker HTTP bearer only to the live bundled FLUJO launch', () => {
    const mode = process.env.FLUJO_WORKER_MODE;
    const token = process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
    try {
      process.env.FLUJO_WORKER_MODE = '1';
      process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'synthetic-worker-token';
      const flujo = createShippedServerConfig(SHIPPED_MCP_SERVERS.find(item => item.defaultName === 'flujo')!);
      const filesystem = createShippedServerConfig(SHIPPED_MCP_SERVERS.find(item => item.defaultName === 'filesystem')!);
      expect(flujo.env).not.toHaveProperty('FLUJO_SNAPSHOT_CONTROL_TOKEN');
      expect(resolveStdioLaunch(flujo).env).toMatchObject({
        FLUJO_WORKER_MODE: '1', FLUJO_SNAPSHOT_CONTROL_TOKEN: 'synthetic-worker-token',
      });
      expect(flujo.env).not.toHaveProperty('FLUJO_SNAPSHOT_CONTROL_TOKEN');
      expect(resolveStdioLaunch(filesystem).env).not.toHaveProperty('FLUJO_SNAPSHOT_CONTROL_TOKEN');
    } finally {
      if (mode === undefined) delete process.env.FLUJO_WORKER_MODE;
      else process.env.FLUJO_WORKER_MODE = mode;
      if (token === undefined) delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
      else process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = token;
    }
  });

  it('forwards only documented environment controls by default', () => {
    const descriptor = SHIPPED_MCP_SERVERS.find((item) => item.defaultName === 'filesystem')!;
    const env = shippedServerEnv(descriptor, {
      FLUJO_DATA_DIR: '/data',
      FLUJO_FS_ROOTS: '/workspace',
      SECRET_THAT_MUST_NOT_LEAK: 'secret',
    });
    expect(env).toMatchObject({
      FLUJO_PARENT_DATA_DIR: path.resolve('/data'),
      FLUJO_DATA_DIR: path.join(path.resolve('/data'), 'workspaces', 'default-workspace'),
      FLUJO_WORKSPACE: 'default-workspace',
      FLUJO_FS_ROOTS: '/workspace',
    });
    expect(env).not.toHaveProperty('SECRET_THAT_MUST_NOT_LEAK');
  });

  it('uses the parent marker instead of nesting a workspace-scoped child root again', () => {
    const descriptor = SHIPPED_MCP_SERVERS.find((item) => item.defaultName === 'filesystem')!;
    const parentDataDir = path.resolve('/parent-data');
    const workspaceDataDir = path.join(parentDataDir, 'workspaces', 'default-workspace');

    expect(shippedServerEnv(descriptor, {
      FLUJO_PARENT_DATA_DIR: parentDataDir,
      FLUJO_DATA_DIR: workspaceDataDir,
    })).toMatchObject({
      FLUJO_PARENT_DATA_DIR: parentDataDir,
      FLUJO_DATA_DIR: workspaceDataDir,
      FLUJO_WORKSPACE: 'default-workspace',
    });
  });

  it('keeps durable browser outputs in the workspace while sharing only package binaries', () => {
    const browser = SHIPPED_MCP_SERVERS.find((item) => item.defaultName === 'browser')!;
    const filesystem = SHIPPED_MCP_SERVERS.find((item) => item.defaultName === 'filesystem')!;
    const environment = {
      FLUJO_DATA_DIR: '/data',
      FLUJO_BROWSER_SCREENSHOT_DIR: '/artifacts/browser',
      FLUJO_BROWSER_MODE: 'trusted',
      FLUJO_BROWSER_WINDOW_VISIBILITY: 'offscreen',
      FLUJO_BROWSER_EXTENSION_DIRS: '/extensions/one:/extensions/two',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    };

    expect(shippedServerEnv(browser, environment)).toMatchObject({
      FLUJO_BROWSER_PROFILE_DIR: path.join(path.resolve('/data'), 'workspaces', 'default-workspace', 'browser-profile', 'trusted'),
      FLUJO_BROWSER_SCREENSHOT_DIR: path.join(path.resolve('/data'), 'workspaces', 'default-workspace', 'screenshots', 'browser'),
      FLUJO_BROWSER_RECORD_DIR: path.join(path.resolve('/data'), 'workspaces', 'default-workspace', 'recordings', 'browser'),
      FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS: '1',
      FLUJO_BROWSER_MODE: 'trusted',
      FLUJO_BROWSER_WINDOW_VISIBILITY: 'offscreen',
      FLUJO_BROWSER_EXTENSION_DIRS: '/extensions/one:/extensions/two',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    });
    expect(shippedServerEnv(browser, {
      ...environment,
      FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS: '0',
    })).toMatchObject({ FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS: '0' });
    expect(shippedServerEnv(filesystem, environment)).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
  });

  it('seeds a fresh bundled browser with the host Patchright cache', () => {
    const browser = SHIPPED_MCP_SERVERS.find((item) => item.defaultName === 'browser')!;
    const environment = process.platform === 'win32'
      ? { FLUJO_DATA_DIR: '/data', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }
      : { FLUJO_DATA_DIR: '/data', HOME: '/home/tester' };
    const expected = process.platform === 'win32'
      ? path.join('C:\\Users\\tester\\AppData\\Local', 'ms-playwright')
      : path.join('/home/tester', '.cache', 'ms-playwright');

    expect(shippedServerEnv(browser, environment).PLAYWRIGHT_BROWSERS_PATH).toBe(expected);
  });
});
