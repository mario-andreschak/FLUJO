jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

import { migrateInternalMcpServers } from '@/backend/services/mcp/internal/migration';
import { SHIPPED_SERVER_NAMES } from '@/backend/services/mcp/internal/registry';
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

describe('internal MCP server persistence migration (#346)', () => {
  it('seeds all shipped servers as ordinary configs and writes the marker last', async () => {
    await migrateInternalMcpServers();

    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers)).toEqual(expect.arrayContaining([...SHIPPED_SERVER_NAMES]));
    for (const name of SHIPPED_SERVER_NAMES) {
      expect(servers[name]).toMatchObject({
        transport: 'stdio',
        command: 'npx',
        disabled: name === 'browser',
        exposeAsMcpServer: true,
      });
      expect(servers[name]).not.toHaveProperty('name');
      expect(servers[name]).not.toHaveProperty('builtIn');
    }
    expect(servers.filesystem).not.toHaveProperty('enableMcpApps');
    expect(storage.get(StorageKey.MCP_INTERNAL_OVERRIDES)).toEqual({});
    expect(storage.get(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1)).toBe(true);
    expect(storage.get(StorageKey.MCP_INTERNAL_CAPABILITIES_MIGRATION_V2)).toBe(true);
    expect(storage.get(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3)).toBe(true);
    expect(saveItemMock.mock.calls.map(([key]) => key)).toEqual([
      StorageKey.MCP_SERVERS,
      StorageKey.MCP_INTERNAL_OVERRIDES,
      StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1,
      StorageKey.MCP_SERVERS,
      StorageKey.MCP_INTERNAL_CAPABILITIES_MIGRATION_V2,
      StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3,
    ]);
  });

  it('preserves same-name configs and transfers disabled/roots only to newly seeded entries', async () => {
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
      flujo: { disabled: true, roots: ['must-not-apply'] },
      filesystem: { disabled: true, roots: ['C:/allowed'] },
      bash: { roots: ['/workspace'] },
    });

    await migrateInternalMcpServers();

    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    expect(servers.flujo).toEqual(existingFlujo);
    expect(servers.other).toEqual({ transport: 'stdio', command: 'other-command' });
    expect(servers.filesystem).toMatchObject({ disabled: true, roots: ['C:/allowed'] });
    expect(servers.bash).toMatchObject({ disabled: false, roots: ['/workspace'] });
  });

  it('adds browser to installations that already completed earlier migrations', async () => {
    storage.set(StorageKey.MCP_SERVERS, { flujo: { transport: 'streamable', url: 'https://custom.test' } });
    storage.set(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1, true);
    storage.set(StorageKey.MCP_INTERNAL_CAPABILITIES_MIGRATION_V2, true);

    await migrateInternalMcpServers();

    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    expect(servers.flujo).toEqual({ transport: 'streamable', url: 'https://custom.test' });
    expect(servers.browser).toMatchObject({
      command: 'npx',
      args: ['--no-install', 'flujo-mcp-browser'],
      disabled: true,
      internalPackage: '@flujo-ai/mcp-browser',
    });
    expect(storage.get(StorageKey.MCP_INTERNAL_BROWSER_MIGRATION_V3)).toBe(true);
  });

  it('coalesces concurrent callers and becomes a no-op after the durable marker', async () => {
    const first = migrateInternalMcpServers();
    const second = migrateInternalMcpServers();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(saveItemMock).toHaveBeenCalledTimes(6);

    saveItemMock.mockClear();
    await migrateInternalMcpServers();
    expect(saveItemMock).not.toHaveBeenCalled();
  });

  it('restores source overrides and retries when the marker write fails', async () => {
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

    await expect(migrateInternalMcpServers()).rejects.toThrow('marker failed');
    expect(storage.get(StorageKey.MCP_INTERNAL_OVERRIDES)).toEqual(overrides);
    expect(storage.has(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1)).toBe(false);

    await migrateInternalMcpServers();
    expect(storage.get(StorageKey.MCP_INTERNAL_OVERRIDES)).toEqual({});
    expect(storage.get(StorageKey.MCP_INTERNAL_SERVERS_MIGRATION_V1)).toBe(true);
  });

  it('does not recreate a shipped server deleted after migration', async () => {
    await migrateInternalMcpServers();
    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    delete servers.filesystem;
    storage.set(StorageKey.MCP_SERVERS, servers);

    saveItemMock.mockClear();
    await migrateInternalMcpServers();

    expect((storage.get(StorageKey.MCP_SERVERS) as Record<string, unknown>).filesystem).toBeUndefined();
    expect(saveItemMock).not.toHaveBeenCalled();
  });
});
