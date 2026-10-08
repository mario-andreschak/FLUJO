jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

import path from 'node:path';
import fs from 'node:fs/promises';
import { getWorkspaceDataDir } from '@/utils/workspace';
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
        disabled: false,
        exposeAsMcpServer: true,
        enableMcpApps: descriptor.enableMcpApps ?? false,
        roots: [],
        source: { type: 'marketplace', id: descriptor.packageId },
      });
      expect(typeof servers[descriptor.defaultName].rootPath).toBe('string');
      expect(servers[descriptor.defaultName].rootPath).toBe(path.join('mcp-servers', descriptor.packageDirectory));
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
    expect(storage.get(StorageKey.MCP_SHIPPED_FLUJO_REPAIR_MIGRATION_V7)).toBe(true);
    expect(storage.get(StorageKey.MCP_SHIPPED_BASH_REPAIR_MIGRATION_V8)).toBe(true);
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
      disabled: false,
      source: { type: 'marketplace', id: '@mario.andreschak/mcp-browser' },
    });
    expect(servers.browser.rootPath).toBe(path.join('mcp-servers', 'browser'));
  });

  it('backfills blank shipped roots and workspace entrypoints without replacing custom roots', async () => {
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
    expect(servers.browser.rootPath).toBe(path.join('mcp-servers', 'browser'));
    expect(path.basename(servers.browser.rootPath as string)).toBe('browser');
    expect(servers.browser.args).toEqual(['./dist/index.js']);
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
    expect(browser.args).toEqual(['./dist/index.js']);
    expect(browser.rootPath).toBe(path.join('mcp-servers', 'browser'));
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

  it('repairs the former FLUJO package id after earlier migrations completed', async () => {
    storage.set(StorageKey.MCP_SERVERS, {
      control: {
        transport: 'stdio',
        command: 'node',
        args: ['.\\dist\\index.js'],
        cwd: process.cwd(),
        rootPath: '.\\mcp-servers\\flujo',
        source: { type: 'marketplace', id: '@flujo-ai/mcp-flujo' },
        disabled: false,
        favorite: true,
        status: 'connected',
        tools: [],
        path: 'mcp-servers\\flujo\\dist\\index.js',
        error: 'Unknown FLUJO tool: create_ticket_for_human',
      },
    });
    storage.set(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);
    storage.set(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3, true);
    storage.set(StorageKey.MCP_SHIPPED_SERVERS_MIGRATION_V4, true);
    storage.set(StorageKey.MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5, true);
    storage.set(StorageKey.MCP_SHIPPED_BROWSER_REPAIR_MIGRATION_V6, true);

    await migrateShippedMcpServers();

    const control = (storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>).control;
    expect(control).toMatchObject({
      command: 'node',
      source: { type: 'marketplace', id: '@mario.andreschak/mcp-flujo' },
      disabled: false,
      favorite: true,
    });
    expect(control.args).toEqual(['./dist/index.js']);
    expect(control.rootPath).toBe(path.join('mcp-servers', 'flujo'));
    expect(control).not.toHaveProperty('error');
    expect(control).not.toHaveProperty('path');
    expect(control).not.toHaveProperty('status');
    expect(control).not.toHaveProperty('tools');
    expect(storage.get(StorageKey.MCP_SHIPPED_FLUJO_REPAIR_MIGRATION_V7)).toBe(true);
  });

  it('normalizes a legacy relative Bash launcher without replacing workspace code', async () => {
    storage.set(StorageKey.MCP_SERVERS, {
      shell: {
        transport: 'stdio',
        command: 'node',
        args: ['.\\dist\\index.js'],
        cwd: process.cwd(),
        rootPath: '.\\mcp-servers\\bash',
        env: { CUSTOM_TERMINAL_SETTING: 'preserved' },
        source: { type: 'marketplace', id: '@mario.andreschak/mcp-bash' },
        disabled: true,
        roots: ['C:/workspace'],
        favorite: true,
        status: 'connected',
        tools: [],
        path: '.\\dist\\index.js',
        stderrOutput: 'old copied server output',
      },
    });
    storage.set(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);
    storage.set(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3, true);
    storage.set(StorageKey.MCP_SHIPPED_SERVERS_MIGRATION_V4, true);
    storage.set(StorageKey.MCP_SHIPPED_SERVER_ROOTS_MIGRATION_V5, true);
    storage.set(StorageKey.MCP_SHIPPED_BROWSER_REPAIR_MIGRATION_V6, true);
    storage.set(StorageKey.MCP_SHIPPED_FLUJO_REPAIR_MIGRATION_V7, true);

    await migrateShippedMcpServers();

    const shell = (storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>).shell;
    expect(shell).toMatchObject({
      command: 'node',
      source: { type: 'marketplace', id: '@mario.andreschak/mcp-bash' },
      disabled: true,
      roots: ['C:/workspace'],
      favorite: true,
      enableMcpApps: true,
      env: expect.objectContaining({ CUSTOM_TERMINAL_SETTING: 'preserved' }),
    });
    expect(shell.args).toEqual(['./dist/index.js']);
    expect(path.basename((shell.args as string[])[0])).toBe('index.js');
    expect(shell.rootPath).toBe(path.join('mcp-servers', 'bash'));
    expect(path.basename(shell.rootPath as string)).toBe('bash');
    expect(shell).not.toHaveProperty('path');
    expect(shell).not.toHaveProperty('status');
    expect(shell).not.toHaveProperty('stderrOutput');
    expect(shell).not.toHaveProperty('tools');
    expect(storage.get(StorageKey.MCP_SHIPPED_BASH_REPAIR_MIGRATION_V8)).toBe(true);
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
    const deletedPackage = path.join(getWorkspaceDataDir(), 'mcp-servers', 'filesystem');
    await fs.rm(deletedPackage, { recursive: true, force: true });

    saveItemMock.mockClear();
    await migrateShippedMcpServers();

    expect((storage.get(StorageKey.MCP_SERVERS) as Record<string, unknown>).filesystem).toBeUndefined();
    expect(saveItemMock).not.toHaveBeenCalled();
    await expect(fs.stat(deletedPackage)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not inspect or recreate a disabled package or a custom name collision', async () => {
    await migrateShippedMcpServers();
    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    servers.bash.disabled = true;
    servers.browser = { transport: 'streamable', url: 'https://custom.test', disabled: false };
    storage.set(StorageKey.MCP_SERVERS, servers);
    for (const name of ['bash', 'browser']) {
      const root = path.join(getWorkspaceDataDir(), 'mcp-servers', name);
      await fs.rm(root, { recursive: true, force: true });
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, 'package.json'), '{"name":"custom-user-package"}');
    }
    await expect(migrateShippedMcpServers()).resolves.toBeUndefined();
    for (const name of ['bash', 'browser']) {
      await expect(fs.readFile(path.join(getWorkspaceDataDir(), 'mcp-servers', name, 'package.json'), 'utf8'))
        .resolves.toBe('{"name":"custom-user-package"}');
      await fs.rm(path.join(getWorkspaceDataDir(), 'mcp-servers', name), { recursive: true });
    }
  });

  it('rebinds an installation-owned record through an application-root alias without claiming custom roots', async () => {
    // Complete historical migrations, then simulate their absolute launch record.
    await migrateShippedMcpServers();
    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    const appRoot = process.env.FLUJO_APP_ROOT ?? process.cwd();
    const packageRoot = path.join(appRoot, 'mcp-servers/bash');
    servers.bash = { ...servers.bash, rootPath: packageRoot, cwd: packageRoot, args: [path.join(packageRoot, 'dist/index.js'), '--kept'] };
    storage.set(StorageKey.MCP_SERVERS, servers);
    const alias = path.join(getWorkspaceDataDir(), 'application-alias');
    await fs.symlink(appRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const previous = process.env.FLUJO_APP_ROOT;
    process.env.FLUJO_APP_ROOT = alias;
    try { await migrateShippedMcpServers(); }
    finally {
      if (previous === undefined) delete process.env.FLUJO_APP_ROOT;
      else process.env.FLUJO_APP_ROOT = previous;
      await fs.rm(alias, { recursive: true });
    }
    expect((storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>).bash).toMatchObject({
      rootPath: path.join('mcp-servers', 'bash'), cwd: path.join('mcp-servers', 'bash'), args: ['./dist/index.js', '--kept'],
    });
  });
});
