/** Tests for persisted internal MCP server configuration and ordinary CRUD. */

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

import path from 'node:path';
import { mcpService } from '@/backend/services/mcp';
import { resolveStdioLaunch } from '@/backend/services/mcp/connection';
import {
  bundledStdioEnv,
  internalServerConfig,
} from '@/backend/services/mcp/internalServerConfig';
import { shippedServerConfig } from '@/backend/services/mcp/internal/registry';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { MCPServerConfig } from '@/shared/types/mcp';

const loadItemMock = loadItem as jest.Mock;
const saveItemMock = saveItem as jest.Mock;
let storage: Map<StorageKey, unknown>;

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
    [StorageKey.MCP_SERVERS, {
      flujo: persisted({ ...internalServerConfig(), disabled: true }),
      filesystem: persisted({ ...shippedServerConfig('filesystem'), disabled: true }),
      bash: persisted({ ...shippedServerConfig('bash'), disabled: true }),
      browser: persisted({ ...shippedServerConfig('browser'), disabled: true }),
    }],
  ]);
  loadItemMock.mockImplementation(async (key: StorageKey, fallback: unknown) =>
    storage.has(key) ? copy(storage.get(key)) : fallback
  );
  saveItemMock.mockImplementation(async (key: StorageKey, value: unknown) => {
    storage.set(key, copy(value));
  });
});

describe('persisted internal configs', () => {
  it('loads the shipped servers only from ordinary MCP_SERVERS records', async () => {
    const configs = await mcpService.loadServerConfigs();
    expect(Array.isArray(configs)).toBe(true);
    const list = configs as MCPServerConfig[];

    for (const name of ['flujo', 'filesystem', 'bash', 'browser']) {
      const config = list.find((candidate) => candidate.name === name);
      expect(config).toBeDefined();
      expect(config).not.toHaveProperty('builtIn');
      expect(config?.exposeAsMcpServer).toBe(true);
    }
  });

  it('does not synthesize a missing shipped server after it is deleted', async () => {
    const result = await mcpService.deleteServerConfig('filesystem');
    expect(result.success).toBe(true);

    const saved = storage.get(StorageKey.MCP_SERVERS) as Record<string, unknown>;
    expect(saved.filesystem).toBeUndefined();
    const reloaded = await mcpService.loadServerConfigs() as MCPServerConfig[];
    expect(reloaded.some((config) => config.name === 'filesystem')).toBe(false);
  });

  it('leaves a pre-existing same-name configuration unchanged', async () => {
    const custom = { transport: 'stdio', command: 'custom-flujo', disabled: true };
    storage.set(StorageKey.MCP_SERVERS, { flujo: custom });

    const configs = await mcpService.loadServerConfigs() as MCPServerConfig[];
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ name: 'flujo', ...custom });
  });
});

describe('standalone stdio configuration', () => {
  it('persists portable offline package-runner commands for every bundled server', () => {
    const expectedCommands: Record<string, string> = {
      flujo: 'flujo-mcp-flujo',
      filesystem: 'flujo-mcp-filesystem',
      bash: 'flujo-mcp-bash',
      browser: 'flujo-mcp-browser',
    };
    for (const [name, executable] of Object.entries(expectedCommands)) {
      const config = shippedServerConfig(name);
      expect(config.command).toBe('npx');
      expect(config.args).toEqual(['--no-install', executable]);
      expect(config.cwd).toBe('');
      expect(config.internalPackage).toBe(`@flujo-ai/mcp-${name}`);
      expect(config.env?.FLUJO_DATA_DIR).toBeTruthy();
    }
  });

  it('declares the Bash package MCP Apps/resource capabilities', () => {
    expect(shippedServerConfig('bash')).toMatchObject({
      disabled: false,
      internalPackage: '@flujo-ai/mcp-bash',
      packageCapabilities: { mcpApps: true, resources: true },
    });
  });

  it('seeds browser automation disabled with MCP Apps/resource capabilities', () => {
    const previous = process.env.FLUJO_BROWSER_ENABLED;
    delete process.env.FLUJO_BROWSER_ENABLED;
    try {
      expect(shippedServerConfig('browser')).toMatchObject({
        disabled: true,
        internalPackage: '@flujo-ai/mcp-browser',
        packageCapabilities: { mcpApps: true, resources: true },
      });
      process.env.FLUJO_BROWSER_ENABLED = '1';
      expect(shippedServerConfig('browser').disabled).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.FLUJO_BROWSER_ENABLED;
      else process.env.FLUJO_BROWSER_ENABLED = previous;
    }
  });

  it('resolves the bundled app root at launch without coupling it to the data directory', () => {
    const previousAppRoot = process.env.FLUJO_APP_ROOT;
    const previousDataDir = process.env.FLUJO_DATA_DIR;
    const appRoot = path.join(process.cwd(), 'read-only-app');
    const dataDir = path.join(process.cwd(), 'relocated-data');
    process.env.FLUJO_APP_ROOT = appRoot;
    process.env.FLUJO_DATA_DIR = dataDir;
    try {
      const launch = resolveStdioLaunch(shippedServerConfig('filesystem'));
      expect(launch.cwd).toBe(path.resolve(appRoot));
      expect(launch.cwd).not.toBe(path.resolve(dataDir));
      expect(launch.args).toEqual(['--no-install', 'flujo-mcp-filesystem']);
      expect(launch.env.FLUJO_DATA_DIR).toBe(dataDir);
    } finally {
      if (previousAppRoot === undefined) delete process.env.FLUJO_APP_ROOT;
      else process.env.FLUJO_APP_ROOT = previousAppRoot;
      if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
      else process.env.FLUJO_DATA_DIR = previousDataDir;
    }
  });

  it('forwards launch context and operator ceilings without leaking unrelated values', () => {
    const previousRoot = process.env.FLUJO_FS_ROOTS;
    const previousBaseUrl = process.env.FLUJO_BASE_URL;
    const previousTls = process.env.NODE_EXTRA_CA_CERTS;
    const previousSecret = process.env.FLUJO_TEST_SECRET;
    process.env.FLUJO_FS_ROOTS = 'operator-root';
    process.env.FLUJO_BASE_URL = 'https://127.0.0.1:4443';
    process.env.NODE_EXTRA_CA_CERTS = 'test-ca.pem';
    process.env.FLUJO_TEST_SECRET = 'do-not-forward';
    try {
      expect(bundledStdioEnv('filesystem')).toMatchObject({
        FLUJO_FS_ROOTS: 'operator-root',
        FLUJO_BASE_URL: 'https://127.0.0.1:4443',
        NODE_EXTRA_CA_CERTS: 'test-ca.pem',
      });
      expect(bundledStdioEnv('filesystem')).not.toHaveProperty('FLUJO_TEST_SECRET');
    } finally {
      if (previousRoot === undefined) delete process.env.FLUJO_FS_ROOTS;
      else process.env.FLUJO_FS_ROOTS = previousRoot;
      if (previousBaseUrl === undefined) delete process.env.FLUJO_BASE_URL;
      else process.env.FLUJO_BASE_URL = previousBaseUrl;
      if (previousTls === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = previousTls;
      if (previousSecret === undefined) delete process.env.FLUJO_TEST_SECRET;
      else process.env.FLUJO_TEST_SECRET = previousSecret;
    }
  });

  it('retains bash full-environment inheritance only with the explicit opt-in', () => {
    const previousInherit = process.env.FLUJO_BASH_INHERIT_ENV;
    const previousSecret = process.env.FLUJO_TEST_SECRET;
    process.env.FLUJO_BASH_INHERIT_ENV = '1';
    process.env.FLUJO_TEST_SECRET = 'explicitly-forwarded';
    try {
      expect(bundledStdioEnv('bash')).toMatchObject({
        FLUJO_BASH_INHERIT_ENV: '1',
        FLUJO_TEST_SECRET: 'explicitly-forwarded',
      });
    } finally {
      if (previousInherit === undefined) delete process.env.FLUJO_BASH_INHERIT_ENV;
      else process.env.FLUJO_BASH_INHERIT_ENV = previousInherit;
      if (previousSecret === undefined) delete process.env.FLUJO_TEST_SECRET;
      else process.env.FLUJO_TEST_SECRET = previousSecret;
    }
  });
});

describe('ordinary CRUD and persistence', () => {
  it('updates internal command/disabled/roots through MCP_SERVERS', async () => {
    const result = await mcpService.updateServerConfig('filesystem', {
      command: 'custom-command',
      disabled: true,
      roots: ['C:/workspace'],
    });
    expect('error' in result ? result.error : undefined).toBeUndefined();

    const saved = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    expect(saved.filesystem).toMatchObject({
      command: 'custom-command',
      disabled: true,
      roots: ['C:/workspace'],
    });
    expect(saveItemMock).toHaveBeenCalledWith(StorageKey.MCP_SERVERS, expect.any(Object));
    expect(saveItemMock).not.toHaveBeenCalledWith(StorageKey.MCP_INTERNAL_OVERRIDES, expect.anything());
  });

  it('requires explicit MCP Apps opt-in for the shipped filesystem server', async () => {
    expect(await mcpService.isMcpAppAccessEnabled('filesystem')).toBe(false);

    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    servers.filesystem.enableMcpApps = true;
    storage.set(StorageKey.MCP_SERVERS, servers);
    expect(await mcpService.isMcpAppAccessEnabled('filesystem')).toBe(true);
  });
});
