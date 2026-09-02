jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
}));

import { loadItem } from '@/utils/storage/backend';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';
import {
  MCP_RUNTIME_HOME_ISOLATION_ENV,
  parseRuntimeHomeIsolationOverride,
  resolveRuntimeHomeIsolation,
} from '@/backend/services/mcp/runtimeHomeIsolation';

const loadItemMock = jest.mocked(loadItem);

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
  beforeEach(() => {
    jest.resetAllMocks();
    loadItemMock.mockResolvedValue(undefined);
  });

  it.each(['1', 'true', 'YES', 'isolated'])(
    'parses %s as an enabled process override',
    (value) => {
      expect(parseRuntimeHomeIsolationOverride(value)).toBe(true);
    },
  );

  it.each(['0', 'false', 'OFF', 'host'])(
    'parses %s as a disabled process override',
    (value) => {
      expect(parseRuntimeHomeIsolationOverride(value)).toBe(false);
    },
  );

  it.each(['', 'sometimes'])('ignores the invalid process override %p', (value) => {
    expect(parseRuntimeHomeIsolationOverride(value)).toBeUndefined();
  });

  it('defaults to disabled', async () => {
    await expect(resolveRuntimeHomeIsolation(stdio(), {})).resolves.toBe(false);
  });

  it('uses the workspace preference when the server inherits', async () => {
    loadItemMock.mockResolvedValue({
      experimental: { mcpRuntimeHomeIsolation: true },
    });

    await expect(resolveRuntimeHomeIsolation(stdio(), {})).resolves.toBe(true);
  });

  it('lets the server override the workspace preference', async () => {
    loadItemMock.mockResolvedValue({
      experimental: { mcpRuntimeHomeIsolation: true },
    });

    await expect(resolveRuntimeHomeIsolation(stdio('host'), {})).resolves.toBe(false);
    await expect(resolveRuntimeHomeIsolation(stdio('isolated'), {})).resolves.toBe(true);
  });

  it('gives the process environment highest precedence', async () => {
    loadItemMock.mockResolvedValue({
      experimental: { mcpRuntimeHomeIsolation: true },
    });

    await expect(
      resolveRuntimeHomeIsolation(stdio('isolated'), {
        [MCP_RUNTIME_HOME_ISOLATION_ENV]: 'off',
      }),
    ).resolves.toBe(false);
    await expect(
      resolveRuntimeHomeIsolation(stdio('host'), {
        [MCP_RUNTIME_HOME_ISOLATION_ENV]: 'on',
      }),
    ).resolves.toBe(true);
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

    await expect(
      resolveRuntimeHomeIsolation(remote, {
        [MCP_RUNTIME_HOME_ISOLATION_ENV]: 'on',
      }),
    ).resolves.toBe(false);
    expect(loadItemMock).not.toHaveBeenCalled();
  });
});
