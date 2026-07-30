/**
 * Tests for the built-in internal server's integration into MCPService:
 * synthetic stdio config injection (stored config wins), CRUD guards, and the
 * never-persist rule in saveConfig.
 */

// Self-contained factories (no closing over outer consts — see jest-test-harness notes).
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => ({})),
  saveItem: jest.fn(async () => undefined),
}));
import { mcpService } from '@/backend/services/mcp';
import { saveConfig } from '@/backend/services/mcp/config';
import {
  INTERNAL_SERVER_NAME,
  builtInStdioEnv,
  internalServerConfig,
} from '@/backend/services/mcp/internalServerConfig';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { MCPServerConfig } from '@/shared/types/mcp';

const loadItemMock = loadItem as jest.Mock;
const saveItemMock = saveItem as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  loadItemMock.mockResolvedValue({});
  saveItemMock.mockResolvedValue(undefined);
});

describe('loadServerConfigs injection', () => {
  it('appends the synthetic built-in config when no stored server claims the name', async () => {
    loadItemMock.mockResolvedValue({ other: { transport: 'stdio', command: 'x' } });
    const configs = await mcpService.loadServerConfigs();
    expect(Array.isArray(configs)).toBe(true);
    const list = configs as MCPServerConfig[];
    const internal = list.find((c) => c.name === INTERNAL_SERVER_NAME);
    expect(internal).toBeDefined();
    expect(internal!.builtIn).toBe(true);
    expect(internal!.disabled).toBe(false);
    expect(internal!.exposeAsMcpServer).toBe(true);
    expect(list.some((c) => c.name === 'other')).toBe(true);
  });

  it('lets a stored server of the same name shadow the built-in one', async () => {
    loadItemMock.mockResolvedValue({ [INTERNAL_SERVER_NAME]: { transport: 'stdio', command: 'x' } });
    const configs = (await mcpService.loadServerConfigs()) as MCPServerConfig[];
    const matches = configs.filter((c) => c.name === INTERNAL_SERVER_NAME);
    expect(matches).toHaveLength(1);
    expect(matches[0].builtIn).toBeUndefined();
  });
});

describe('standalone stdio configuration', () => {
  it('launches the flujo package through Node instead of short-circuiting in process', () => {
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
      expect(builtInStdioEnv('filesystem')).toMatchObject({
        FLUJO_FS_ROOTS: 'operator-root',
      });
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

describe('CRUD guards', () => {
  it('allows toggling the built-in server on/off via a persisted override (issue #170)', async () => {
    const result = await mcpService.updateServerConfig(INTERNAL_SERVER_NAME, { disabled: true });
    // Toggling is NOT an error: it returns the synthetic config, and it is persisted
    // to the internal-overrides key — never to MCP_SERVERS.
    expect('error' in result ? result.error : undefined).toBeUndefined();
    expect(saveItemMock).toHaveBeenCalled();
    const [key, value] = saveItemMock.mock.calls[0];
    expect(key).toBe(StorageKey.MCP_INTERNAL_OVERRIDES);
    expect((value as Record<string, { disabled?: boolean }>)[INTERNAL_SERVER_NAME].disabled).toBe(true);
  });

  it('still refuses to edit non-toggle fields of the built-in server', async () => {
    const result = await mcpService.updateServerConfig(INTERNAL_SERVER_NAME, { command: 'evil' } as Partial<MCPServerConfig>);
    expect('error' in result && result.error).toMatch(/built-in/i);
  });

  it('refuses to delete the built-in server', async () => {
    const result = await mcpService.deleteServerConfig(INTERNAL_SERVER_NAME);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/built-in/i);
    expect(saveItemMock).not.toHaveBeenCalled();
  });

  it('refuses to rename another server onto the reserved name', async () => {
    loadItemMock.mockResolvedValue({ other: { transport: 'stdio', command: 'x' } });
    const result = await mcpService.updateServerConfig('other', { name: INTERNAL_SERVER_NAME });
    expect('error' in result && result.error).toMatch(/already exists/i);
  });

  it('still allows editing a stored server that shadows the name', async () => {
    loadItemMock.mockResolvedValue({ [INTERNAL_SERVER_NAME]: { transport: 'stdio', command: 'x' } });
    const result = await mcpService.updateServerConfig(INTERNAL_SERVER_NAME, { disabled: true });
    expect('error' in result ? result.error : undefined).toBeUndefined();
    expect(saveItemMock).toHaveBeenCalled();
  });
});

describe('persistence', () => {
  it('saveConfig never writes builtIn entries to storage', async () => {
    const configs = new Map<string, MCPServerConfig>();
    configs.set(INTERNAL_SERVER_NAME, internalServerConfig());
    configs.set('real', {
      name: 'real',
      transport: 'stdio',
      command: 'x',
      args: [],
      env: {},
      disabled: false,
      autoApprove: [],
      rootPath: '',
      _buildCommand: '',
      _installCommand: '',
    } as MCPServerConfig);

    const result = await saveConfig(configs);
    expect(result.success).toBe(true);

    const saved = saveItemMock.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual(['real']);
  });

  it('updating another server does not leak the synthetic entry into storage', async () => {
    loadItemMock.mockResolvedValue({ other: { transport: 'stdio', command: 'x' } });
    // disabled: true keeps handleConnectionStateChange from attempting a real connect.
    const result = await mcpService.updateServerConfig('other', { disabled: true });
    expect('error' in result ? result.error : undefined).toBeUndefined();

    const saved = saveItemMock.mock.calls[0][1] as Record<string, unknown>;
    expect(saved.other).toBeDefined();
    expect(saved[INTERNAL_SERVER_NAME]).toBeUndefined();
  });
});

describe('multiple built-in servers (issue #170)', () => {
  it('injects filesystem and bash as enabled built-in servers', async () => {
    const configs = (await mcpService.loadServerConfigs()) as MCPServerConfig[];
    const fsCfg = configs.find((c) => c.name === 'filesystem');
    const bashCfg = configs.find((c) => c.name === 'bash');
    expect(fsCfg?.builtIn).toBe(true);
    expect(fsCfg?.disabled).toBe(false);
    expect(bashCfg?.builtIn).toBe(true);
    expect(bashCfg?.disabled).toBe(false);
  });

  it('applies a persisted disabled override and gates a disabled built-in', async () => {
    loadItemMock.mockImplementation(async (key: string) =>
      key === StorageKey.MCP_INTERNAL_OVERRIDES ? { filesystem: { disabled: true } } : {}
    );
    const configs = (await mcpService.loadServerConfigs()) as MCPServerConfig[];
    expect(configs.find((c) => c.name === 'filesystem')?.disabled).toBe(true);
    const { tools, error } = await mcpService.listServerTools('filesystem');
    expect(tools).toEqual([]);
    expect(error).toMatch(/disabled/i);
  });

  it('configures filesystem and bash as real stdio child processes', async () => {
    const configs = (await mcpService.loadServerConfigs()) as MCPServerConfig[];
    for (const name of ['filesystem', 'bash']) {
      const config = configs.find((candidate) => candidate.name === name);
      expect(config?.command).toBe(process.execPath);
      expect(config?.args?.[0]).toMatch(new RegExp(`mcp-servers[\\\\/]${name}[\\\\/]dist[\\\\/]index\\.js$`));
    }
  });
});

