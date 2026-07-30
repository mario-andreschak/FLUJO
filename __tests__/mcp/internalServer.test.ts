/** Tests for persisted internal MCP server configuration and ordinary CRUD. */

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

import { mcpService } from '@/backend/services/mcp';
import { saveConfig } from '@/backend/services/mcp/config';
import {
  INTERNAL_SERVER_NAME,
  builtInStdioEnv,
  internalServerConfig,
} from '@/backend/services/mcp/internalServerConfig';
import { builtInServerConfig } from '@/backend/services/mcp/internal/registry';
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
      filesystem: persisted({ ...builtInServerConfig('filesystem'), disabled: true }),
      bash: persisted({ ...builtInServerConfig('bash'), disabled: true }),
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

    for (const name of ['flujo', 'filesystem', 'bash']) {
      const config = list.find((candidate) => candidate.name === name);
      expect(config).toBeDefined();
      expect(config?.builtIn).toBeUndefined();
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
  it('launches the flujo package through Node', () => {
    const config = internalServerConfig();
    expect(config.command).toBe(process.execPath);
    expect(config.args).toHaveLength(1);
    expect(config.args[0]).toMatch(/mcp-servers[\\/]flujo[\\/]dist[\\/]index\.js$/);
    expect(config.cwd).toMatch(/mcp-servers[\\/]flujo[\\/]dist$/);
    expect(config.env?.FLUJO_DATA_DIR).toBeTruthy();
  });

  it('forwards operator ceilings without leaking unrelated environment values', () => {
    const previousRoot = process.env.FLUJO_FS_ROOTS;
    const previousSecret = process.env.FLUJO_TEST_SECRET;
    process.env.FLUJO_FS_ROOTS = 'operator-root';
    process.env.FLUJO_TEST_SECRET = 'do-not-forward';
    try {
      expect(builtInStdioEnv('filesystem')).toMatchObject({ FLUJO_FS_ROOTS: 'operator-root' });
      expect(builtInStdioEnv('filesystem')).not.toHaveProperty('FLUJO_TEST_SECRET');
    } finally {
      if (previousRoot === undefined) delete process.env.FLUJO_FS_ROOTS;
      else process.env.FLUJO_FS_ROOTS = previousRoot;
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
      expect(builtInStdioEnv('bash')).toMatchObject({
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

  it('saveConfig no longer filters entries carrying the legacy builtIn field', async () => {
    const legacy = { ...internalServerConfig(), builtIn: true } as MCPServerConfig;
    const result = await saveConfig(new Map([[INTERNAL_SERVER_NAME, legacy]]));
    expect(result.success).toBe(true);

    const saved = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    expect(saved[INTERNAL_SERVER_NAME]).toMatchObject({ builtIn: true, exposeAsMcpServer: true });
  });

  it('keeps filesystem MCP Apps opt-in after builtIn is removed', async () => {
    expect(await mcpService.isMcpAppAccessEnabled('filesystem')).toBe(false);

    const servers = storage.get(StorageKey.MCP_SERVERS) as Record<string, Record<string, unknown>>;
    servers.filesystem.enableMcpApps = true;
    storage.set(StorageKey.MCP_SERVERS, servers);
    expect(await mcpService.isMcpAppAccessEnabled('filesystem')).toBe(true);
  });
});
