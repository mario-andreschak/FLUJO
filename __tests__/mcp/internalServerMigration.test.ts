jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

import path from 'node:path';
import { migrateShippedMcpServers } from '@/backend/services/mcp/shippedServerMigration';
import { SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';

const loadItemMock = loadItem as jest.Mock;
const saveItemMock = saveItem as jest.Mock;
let storage: Map<StorageKey, unknown>;

function copy<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? value : JSON.parse(serialized) as T;
}

function installStorageMocks(): void {
  loadItemMock.mockImplementation(async (key: StorageKey, fallback: unknown) =>
    storage.has(key) ? copy(storage.get(key)) : fallback
  );
  saveItemMock.mockImplementation(async (key: StorageKey, value: unknown) => {
    storage.set(key, copy(value));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FLUJO_BROWSER_ENABLED;
  storage = new Map();
  installStorageMocks();
});

describe('shipped MCP package migration (#347)', () => {
  it('seeds complete ordinary stdio records', async () => {
    await migrateShippedMcpServers();

    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    for (const descriptor of SHIPPED_MCP_SERVERS) {
      expect(servers[descriptor.defaultName]).toMatchObject({
        transport: 'stdio',
        command: 'node',
        disabled: descriptor.defaultName === 'browser',
        exposeAsMcpServer: true,
        enableMcpApps: descriptor.enableMcpApps ?? false,
        roots: [],
        source: { type: 'marketplace', id: descriptor.packageId },
      });
      expect(typeof servers[descriptor.defaultName].rootPath).toBe('string');
      expect(path.isAbsolute(servers[descriptor.defaultName].rootPath as string)).toBe(true);
      expect(servers[descriptor.defaultName]).not.toHaveProperty('name');
      expect(servers[descriptor.defaultName]).not.toHaveProperty('builtIn');
      expect(servers[descriptor.defaultName]).not.toHaveProperty('internalPackage');
      expect(servers[descriptor.defaultName]).not.toHaveProperty('packageCapabilities');
    }
    expect(storage.get(StorageKey.MCP_INTERNAL_OVERRIDES)).toEqual({});
    expect(storage.get(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1)).toBe(true);
    expect(storage.get(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3)).toBe(true);
    expect(storage.get(StorageKey.MCP_SHIPPED_SERVERS_MIGRATION_V4)).toBe(true);
    expect(storage.get(StorageKey.MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5)).toBe(true);
    expect(storage.get(StorageKey.MCP_SHIPPED_BROWSER_REPAIR_MIGRATION_V6)).toBe(true);
  });

  it('preserves a user-owned same-name config and transfers all legacy override fields only to new records', async () => {
    const existingFlujo = {
      transport: 'streamable',
      url: 'https://example.test/custom',
      disabled: false,
      custom: 'untouched',
    };
    storage.set(StorageKey.MCP_SERVERS, {
      flujo: existingFlujo,
      other: { transport: 'stdio', command: 'other-command' },
    });
    storage.set(StorageKey.MCP_INTERNAL_OVERRIDES, {
      flujo: { disabled: true, roots: ['must-not-apply'], enableMcpApps: true },
      filesystem: {
        disabled: true,
        roots: ['C:/allowed'],
        exposeAsMcpServer: false,
        enableMcpApps: true,
      },
      bash: { roots: ['/workspace'] },
    });

    await migrateShippedMcpServers();

    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    expect(servers.flujo).toEqual(existingFlujo);
    expect(servers.other).toEqual({ transport: 'stdio', command: 'other-command' });
    expect(servers.filesystem).toMatchObject({
      disabled: true,
      roots: ['C:/allowed'],
      exposeAsMcpServer: false,
      enableMcpApps: true,
    });
    expect(servers.bash).toMatchObject({ disabled: false, roots: ['/workspace'] });
  });

  it('upgrades a renamed legacy package record without relying on its display name', async () => {
    storage.set(StorageKey.MCP_SERVERS, {
      shell: {
        transport: 'stdio',
        command: 'npx',
        args: ['--no-install', 'flujo-mcp-bash'],
        cwd: '',
        env: {},
        disabled: true,
        roots: ['/workspace'],
        internalPackage: '@mario.andreschak/mcp-bash',
        packageCapabilities: { mcpApps: true },
      },
    });
    storage.set(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);
    storage.set(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3, true);

    await migrateShippedMcpServers();

    const shell = (storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>).shell;
    expect(shell).toMatchObject({
      command: 'node',
      disabled: true,
      roots: ['/workspace'],
      source: { type: 'marketplace', id: '@mario.andreschak/mcp-bash' },
      hostPathAccess: { snapshots: true },
    });
    expect(shell).not.toHaveProperty('internalPackage');
    expect(shell).not.toHaveProperty('packageCapabilities');
    expect((storage.get(StorageKey.MCP_SERVERS) as Record<string, unknown>).bash).toBeUndefined();
  });

  it('adds browser to installations that completed the original seed migration', async () => {
    storage.set(StorageKey.MCP_SERVERS, {
      flujo: { transport: 'streamable', url: 'https://custom.test' },
    });
    storage.set(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);

    await migrateShippedMcpServers();

    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    expect(servers.flujo).toEqual({ transport: 'streamable', url: 'https://custom.test' });
    expect(servers.browser).toMatchObject({
      command: 'node',
      disabled: true,
      source: { type: 'marketplace', id: '@mario.andreschak/mcp-browser' },
    });
    expect(path.isAbsolute(servers.browser.rootPath as string)).toBe(true);
  });

  it('backfills blank shipped roots and absolute entrypoints without replacing custom roots', async () => {
    storage.set(StorageKey.MCP_SERVERS, {
      browser: {
        transport: 'stdio',
        command: 'node',
        args: ['mcp-servers/browser/dist/index.js'],
        rootPath: '',
        source: { type: 'marketplace', id: '@mario.andreschak/mcp-browser' },
      },
      shell: {
        transport: 'stdio',
        command: 'node',
        args: ['custom-entry.js'],
        rootPath: 'C:/custom/shell-root',
        source: { type: 'marketplace', id: '@mario.andreschak/mcp-bash' },
      },
    });
    storage.set(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);
    storage.set(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3, true);
    storage.set(StorageKey.MCP_SHIPPED_SERVERS_MIGRATION_V4, true);

    await migrateShippedMcpServers();

    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    expect(path.isAbsolute(servers.browser.rootPath as string)).toBe(true);
    expect(path.basename(servers.browser.rootPath as string)).toBe('browser');
    expect(path.isAbsolute((servers.browser.args as string[])[0])).toBe(true);
    expect(servers.shell).toMatchObject({
      args: ['custom-entry.js'],
      rootPath: 'C:/custom/shell-root',
    });
  });

  it('repairs the former browser package id after V4/V5 were already marked complete', async () => {
    storage.set(StorageKey.MCP_SERVERS, {
      browser: {
        transport: 'stdio',
        command: 'node',
        args: ['.\\dist\\index.js'],
        cwd: process.cwd(),
        rootPath: './mcp-servers/browser',
        env: { FLUJO_DATA_DIR: { value: '.\\userdata', metadata: { isSecret: false } } },
        source: { type: 'marketplace', id: '@flujo-ai/mcp-browser' },
        disabled: false,
        favorite: true,
        status: 'connected',
        tools: [],
        path: 'mcp-servers\\browser\\dist\\index.js',
        error: 'Cannot find module duplicated/path',
        stderrOutput: 'Cannot find module duplicated/path',
      },
    });
    storage.set(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);
    storage.set(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3, true);
    storage.set(StorageKey.MCP_SHIPPED_SERVERS_MIGRATION_V4, true);
    storage.set(StorageKey.MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5, true);

    await migrateShippedMcpServers();

    const browser = (storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>).browser;
    expect(browser).toMatchObject({
      command: 'node',
      source: { type: 'marketplace', id: '@mario.andreschak/mcp-browser' },
      disabled: false,
      favorite: true,
      enableMcpApps: true,
    });
    expect(path.isAbsolute((browser.args as string[])[0])).toBe(true);
    expect(path.isAbsolute(browser.rootPath as string)).toBe(true);
    expect(path.isAbsolute(((browser.env as Record<string, { value: string }>).FLUJO_DATA_DIR).value)).toBe(true);
    expect(browser).not.toHaveProperty('error');
    expect(browser).not.toHaveProperty('path');
    expect(browser).not.toHaveProperty('status');
    expect(browser).not.toHaveProperty('stderrOutput');
    expect(browser).not.toHaveProperty('tools');
    expect(storage.get(StorageKey.MCP_SHIPPED_BROWSER_REPAIR_MIGRATION_V6)).toBe(true);
  });

  it('does not claim a user-owned browser config during the V6 repair', async () => {
    const custom = {
      transport: 'stdio',
      command: 'custom-browser',
      args: ['serve.js'],
      source: { type: 'manual', id: 'custom' },
    };
    storage.set(StorageKey.MCP_SERVERS, { browser: custom });
    storage.set(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);
    storage.set(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3, true);
    storage.set(StorageKey.MCP_SHIPPED_SERVERS_MIGRATION_V4, true);
    storage.set(StorageKey.MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5, true);

    await migrateShippedMcpServers();

    expect((storage.get(StorageKey.MCP_SERVERS) as Record<string, unknown>).browser).toEqual(custom);
  });

  it('coalesces concurrent callers and becomes a no-op after durable markers', async () => {
    const first = migrateShippedMcpServers();
    const second = migrateShippedMcpServers();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    saveItemMock.mockClear();
    await migrateShippedMcpServers();
    expect(saveItemMock).not.toHaveBeenCalled();
  });

  it('restores source overrides and retries when the V1 marker write fails', async () => {
    const overrides = { filesystem: { disabled: true, roots: ['C:/retry'] } };
    storage.set(StorageKey.MCP_INTERNAL_OVERRIDES, overrides);
    let failMarker = true;
    saveItemMock.mockImplementation(async (key: StorageKey, value: unknown) => {
      if (key === StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1 && failMarker) {
        failMarker = false;
        throw new Error('marker failed');
      }
      storage.set(key, copy(value));
    });

    await expect(migrateShippedMcpServers()).rejects.toThrow('marker failed');
    expect(storage.get(StorageKey.MCP_INTERNAL_OVERRIDES)).toEqual(overrides);
    expect(storage.has(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1)).toBe(false);

    await migrateShippedMcpServers();
    expect(storage.get(StorageKey.MCP_INTERNAL_OVERRIDES)).toEqual({});
    expect(storage.get(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1)).toBe(true);
    expect((storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>).filesystem)
      .toMatchObject({ disabled: true, roots: ['C:/retry'] });
  });

  it('does not recreate a package deleted after migration', async () => {
    await migrateShippedMcpServers();
    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    delete servers.filesystem;
    storage.set(StorageKey.MCP_SERVERS, servers);

    saveItemMock.mockClear();
    await migrateShippedMcpServers();

    expect((storage.get(StorageKey.MCP_SERVERS) as Record<string, unknown>).filesystem).toBeUndefined();
    expect(saveItemMock).not.toHaveBeenCalled();
  });
});
