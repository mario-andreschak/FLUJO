jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  loadItemForBackup: jest.fn(),
  saveItem: jest.fn(),
}));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'runtime-home-test' }));

import { loadItem, loadItemForBackup, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';
import {
  _resetRuntimeHomeMigrationForTests,
  resolveRuntimeHomeIsolation,
} from '@/backend/services/mcp/runtimeHomeIsolation';

const loadItemMock = jest.mocked(loadItem);
const loadRawMock = jest.mocked(loadItemForBackup);
const saveItemMock = jest.mocked(saveItem);

function stdio(runtimeHomeMode?: MCPStdioConfig['runtimeHomeMode']): MCPStdioConfig {
  return {
    name: 'runtime-policy-test',
    transport: 'stdio',
    command: 'node',
    args: [],
    env: {},
    disabled: false,
    rootPath: '',
    _buildCommand: '',
    _installCommand: '',
    runtimeHomeMode,
  };
}

describe('MCP runtime-home isolation policy', () => {
  const original = process.env.FLUJO_MCP_RUNTIME_HOME_ISOLATION;

  beforeEach(() => {
    jest.resetAllMocks();
    _resetRuntimeHomeMigrationForTests();
    loadRawMock.mockResolvedValue(null);
    loadItemMock.mockResolvedValue({});
    saveItemMock.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (original === undefined) delete process.env.FLUJO_MCP_RUNTIME_HOME_ISOLATION;
    else process.env.FLUJO_MCP_RUNTIME_HOME_ISOLATION = original;
  });

  it('uses the host home unless the server says isolated', async () => {
    await expect(resolveRuntimeHomeIsolation(stdio())).resolves.toBe(false);
    await expect(resolveRuntimeHomeIsolation(stdio('inherit'))).resolves.toBe(false);
    await expect(resolveRuntimeHomeIsolation(stdio('host'))).resolves.toBe(false);
    await expect(resolveRuntimeHomeIsolation(stdio('isolated'))).resolves.toBe(true);
  });

  it('ignores the retired process override (#1449)', async () => {
    process.env.FLUJO_MCP_RUNTIME_HOME_ISOLATION = 'on';
    await expect(resolveRuntimeHomeIsolation(stdio('host'))).resolves.toBe(false);
    process.env.FLUJO_MCP_RUNTIME_HOME_ISOLATION = 'off';
    await expect(resolveRuntimeHomeIsolation(stdio('isolated'))).resolves.toBe(true);
  });

  it('moves a retired workspace-wide switch into each stdio server once', async () => {
    const settings = { experimental: { mcpRuntimeHomeIsolation: true, requireMcpAppLaunchClick: true } };
    loadRawMock.mockResolvedValue(settings);
    loadItemMock.mockResolvedValue({
      follows: { ...stdio(), name: 'follows' },
      inherits: { ...stdio('inherit'), name: 'inherits' },
      host: { ...stdio('host'), name: 'host' },
      remote: { name: 'remote', transport: 'streamable', serverUrl: 'https://example.com/mcp' },
    });

    await expect(resolveRuntimeHomeIsolation(stdio())).resolves.toBe(true);
    await expect(resolveRuntimeHomeIsolation(stdio('inherit'))).resolves.toBe(true);
    await expect(resolveRuntimeHomeIsolation(stdio('host'))).resolves.toBe(false);

    expect(saveItemMock).toHaveBeenCalledTimes(2);
    const servers = saveItemMock.mock.calls[0];
    expect(servers[0]).toBe(StorageKey.MCP_SERVERS);
    expect(servers[1]).toMatchObject({
      follows: { runtimeHomeMode: 'isolated' },
      inherits: { runtimeHomeMode: 'isolated' },
      host: { runtimeHomeMode: 'host' },
      remote: { transport: 'streamable' },
    });
    expect(servers[1]).not.toHaveProperty('remote.runtimeHomeMode');
    expect(saveItemMock.mock.calls[1]).toEqual([StorageKey.SPEECH_SETTINGS, settings]);
  });

  it('keeps the host home when the old switch cannot be read', async () => {
    loadRawMock.mockRejectedValue(new Error('locked'));
    await expect(resolveRuntimeHomeIsolation(stdio())).resolves.toBe(false);
    expect(saveItemMock).not.toHaveBeenCalled();
  });

  it('does not apply runtime-home isolation to remote transports', async () => {
    const remote: MCPServerConfig = {
      name: 'remote-policy-test',
      transport: 'streamable',
      serverUrl: 'https://example.com/mcp',
      env: {},
      disabled: false,
      rootPath: '',
      _buildCommand: '',
      _installCommand: '',
    };

    await expect(resolveRuntimeHomeIsolation(remote)).resolves.toBe(false);
    expect(loadRawMock).not.toHaveBeenCalled();
  });
});
