/**
 * `launch` (#392) is an ADDITIVE optional field, so it must survive persistence
 * without a migration — and, just as importantly, its absence must not leave a
 * `launch: undefined` key behind in stored JSON for every existing server.
 */

const mockStore: Record<string, unknown> = {};

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) =>
    key in mockStore ? mockStore[key] : defaultValue),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    mockStore[key] = JSON.parse(JSON.stringify(value));
  }),
}));

jest.mock('simple-git', () => ({
  __esModule: true,
  default: jest.fn(() => ({ getRemotes: jest.fn(async () => []) })),
}));

import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { StorageKey } from '@/shared/types/storage';
import type { MCPServerConfig, MCPStreamableConfig } from '@/shared/types/mcp';

const launchServer = (): MCPStreamableConfig => ({
  name: 'weather-mcp',
  transport: 'streamable',
  serverUrl: 'http://localhost:8088/mcp',
  headers: {},
  env: {},
  disabled: false,
  rootPath: '.',
  source: { type: 'registry', registryName: 'io.github.example/weather-mcp' },
  launch: {
    command: 'docker',
    args: ['run', '-i', '--rm', 'example/weather-mcp:1.0.0'],
    env: { PORT: '8088' },
  },
} as unknown as MCPStreamableConfig);

beforeEach(() => {
  for (const key of Object.keys(mockStore)) delete mockStore[key];
});

const roundTrip = async (config: MCPServerConfig): Promise<MCPServerConfig> => {
  await saveConfig(new Map([[config.name, config]]));
  const loaded = await loadServerConfigs();
  if (!Array.isArray(loaded)) throw new Error('expected configs');
  return loaded[0];
};

describe('launch spec persistence', () => {
  it('survives save → load unchanged', async () => {
    const loaded = (await roundTrip(launchServer())) as MCPStreamableConfig;
    expect(loaded.transport).toBe('streamable');
    expect(loaded.serverUrl).toBe('http://localhost:8088/mcp');
    expect(loaded.launch).toEqual({
      command: 'docker',
      args: ['run', '-i', '--rm', 'example/weather-mcp:1.0.0'],
      env: { PORT: '8088' },
    });
  });

  it('survives a second save → load byte-identically', async () => {
    const first = await roundTrip(launchServer());
    const stored = JSON.parse(JSON.stringify(mockStore[StorageKey.MCP_SERVERS]));
    await roundTrip(first);
    expect(mockStore[StorageKey.MCP_SERVERS]).toEqual(stored);
  });

  it('never introduces a launch key on a server that has none', async () => {
    const stdio = {
      name: 'plain-mcp',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      env: {},
      disabled: false,
      rootPath: '.',
    } as unknown as MCPServerConfig;
    const loaded = await roundTrip(stdio);
    expect('launch' in loaded).toBe(false);
    const stored = mockStore[StorageKey.MCP_SERVERS] as Record<string, Record<string, unknown>>;
    expect(Object.keys(stored['plain-mcp'])).not.toContain('launch');
  });
});
