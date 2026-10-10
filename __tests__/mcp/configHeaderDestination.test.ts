import type { MCPHeaderValue, MCPServerConfig } from '@/shared/types/mcp';
import { MASKED_API_KEY, MASKED_STRING } from '@/shared/types/constants';
import { MCP_HEADER_DESTINATION_CHANGED } from '@/utils/mcp/headerDestination';

const mockLoadServerConfigs = jest.fn();
const mockSaveConfig = jest.fn(async (_configs: unknown) => ({ success: true }));
const mockEncryptApiKey = jest.fn(async (value: string) => `encrypted:${value}`);

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...args: unknown[]) => mockLoadServerConfigs(...args),
  saveConfig: (configs: unknown) => mockSaveConfig(configs),
}));
jest.mock('@/backend/services/model/encryption', () => ({
  encryptApiKey: (value: string) => mockEncryptApiKey(value),
}));
jest.mock('@/backend/services/flow', () => ({
  flowService: { migrateMcpServerReferences: jest.fn(async () => ({ success: true, migratedReferences: 0 })) },
}));
jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: jest.fn(),
  createTransport: jest.fn(),
  resolveConfigHeaders: jest.fn(),
  safelyCloseClient: jest.fn(),
  shouldRecreateClient: jest.fn(),
}));

import { MCPService } from '@/backend/services/mcp';

const secret = (value: string): MCPHeaderValue => ({ value, metadata: { isSecret: true } });
const storedServer = {
  name: 'saved', transport: 'streamable', serverUrl: 'https://saved.example/mcp?tenant=1',
  headers: { Authorization: secret('encrypted:SYNTHETIC_SAVED_HEADER') },
  env: {}, rootPath: '', disabled: true,
} as unknown as MCPServerConfig;

type SaveSeams = {
  ensureManagedServerRootDir: jest.Mock;
  handleConnectionStateChange: jest.Mock;
};
let service: MCPService;
let seams: SaveSeams;

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadServerConfigs.mockResolvedValue([structuredClone(storedServer)]);
  service = new MCPService();
  seams = service as unknown as SaveSeams;
  seams.ensureManagedServerRootDir = jest.fn(async () => undefined);
  seams.handleConnectionStateChange = jest.fn(async () => undefined);
});

function savedConfig(): MCPServerConfig & { headers: Record<string, MCPHeaderValue> } {
  return (mockSaveConfig.mock.calls[0][0] as Map<string, MCPServerConfig>).values().next().value as
    MCPServerConfig & { headers: Record<string, MCPHeaderValue> };
}

describe('saved MCP custom header destination', () => {
  it.each(['streamable', 'sse'] as const)('creates a %s server without inherited stdio launch fields', async transport => {
    mockLoadServerConfigs.mockResolvedValue([]);
    await service.updateServerConfig('new-private', {name:'new-private',transport,
      serverUrl:'http://127.0.0.1:12345/mcp',disabled:true,
      headers:{Authorization:secret('SYNTHETIC_PRIVATE_HEADER')}});
    const saved=savedConfig();
    expect(saved.transport).toBe(transport);
    for(const key of ['command','args'])expect(saved).not.toHaveProperty(key);
    expect(saved.headers.Authorization).toEqual(secret('encrypted:SYNTHETIC_PRIVATE_HEADER'));
    expect(mockEncryptApiKey).toHaveBeenCalledWith('SYNTHETIC_PRIVATE_HEADER');
  });
  it.each([MASKED_API_KEY, MASKED_STRING])('preserves a masked secret for an ordinary edit: %s', async (mask) => {
    await service.updateServerConfig('saved', { headers: { Authorization: secret(mask) }, disabled: true });
    expect(savedConfig().headers.Authorization).toEqual(secret('encrypted:SYNTHETIC_SAVED_HEADER'));
    expect(mockEncryptApiKey).not.toHaveBeenCalled();
    expect(seams.handleConnectionStateChange).toHaveBeenCalledTimes(1);
  });

  it('allows rename and URL normalization at the same endpoint', async () => {
    const result = await service.updateServerConfig('saved', {
      name: 'renamed', serverUrl: 'https://SAVED.example:443/mcp?tenant=1#editor',
      headers: { Authorization: secret(MASKED_API_KEY) },
    } as Partial<MCPServerConfig>);
    expect(result).toMatchObject({ name: 'renamed' });
    expect(savedConfig().headers.Authorization).toEqual(secret('encrypted:SYNTHETIC_SAVED_HEADER'));
    expect(seams.handleConnectionStateChange).toHaveBeenCalledWith('renamed', expect.any(Object));
  });

  it('preserves implicitly inherited secret headers at the same endpoint', async () => {
    await service.updateServerConfig('saved', { disabled: true });
    expect(savedConfig().headers).toEqual((storedServer as unknown as { headers: unknown }).headers);
  });

  const retargets = [
    { serverUrl: 'https://other.example/mcp?tenant=1' },
    { name: 'renamed', serverUrl: 'https://other.example/mcp?tenant=1' },
    { serverUrl: 'http://saved.example/mcp?tenant=1' },
    { serverUrl: 'https://saved.example:444/mcp?tenant=1' },
    { serverUrl: 'https://saved.example/other?tenant=1' },
    { serverUrl: 'https://saved.example/mcp?tenant=2' },
    { serverUrl: 'not a URL' },
    { transport: 'sse' },
    { transport: 'stdio' },
    { transport: 'websocket' },
  ];
  describe.each(['masked', 'omitted'] as const)('%s saved headers', (headerEdit) => {
    it.each(retargets)('refuses retarget %j before encrypting, saving, or changing lifecycle', async (retarget) => {
      const updates = {
        ...retarget,
        ...(headerEdit === 'masked' ? { headers: { Authorization: secret(MASKED_API_KEY) } } : {}),
        env: { NEW_TOKEN: secret('SYNTHETIC_NEW_ENV') },
      } as Partial<MCPServerConfig>;
      const before = structuredClone(updates);
      const result = await service.updateServerConfig('saved', updates);
      expect(result).toEqual({ success: false, error: MCP_HEADER_DESTINATION_CHANGED, statusCode: 400 });
      expect(mockEncryptApiKey).not.toHaveBeenCalled();
      expect(mockSaveConfig).not.toHaveBeenCalled();
      expect(seams.ensureManagedServerRootDir).not.toHaveBeenCalled();
      expect(seams.handleConnectionStateChange).not.toHaveBeenCalled();
      expect(updates).toEqual(before);
      await expect(mockLoadServerConfigs.mock.results[0].value).resolves.toEqual([storedServer]);
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SAVED_HEADER');
    });
  });

  it.each(['fresh', 'clear'] as const)('allows a changed destination with explicit %s headers', async (edit) => {
    const result = await service.updateServerConfig('saved', {
      serverUrl: 'https://other.example/mcp',
      headers: edit === 'fresh' ? { Authorization: secret('SYNTHETIC_FRESH_HEADER') } : {},
    } as Partial<MCPServerConfig>);
    expect(result).toMatchObject({ serverUrl: 'https://other.example/mcp' });
    expect(savedConfig().headers).toEqual(edit === 'fresh'
      ? { Authorization: secret('encrypted:SYNTHETIC_FRESH_HEADER') } : {});
    expect(JSON.stringify(savedConfig())).not.toContain('SYNTHETIC_SAVED_HEADER');
  });

  it('allows a retarget when omitted headers contain only public values', async () => {
    mockLoadServerConfigs.mockResolvedValue([{ ...storedServer, headers: { Accept: 'application/json' } }]);
    await service.updateServerConfig('saved', { serverUrl: 'https://other.example/mcp' } as Partial<MCPServerConfig>);
    expect(savedConfig().headers).toEqual({ Accept: 'application/json' });
  });

  it('drops orphan masks at a new destination without reusing other stored headers', async () => {
    await service.updateServerConfig('saved', {
      serverUrl: 'https://other.example/mcp', headers: { 'X-Missing-Token': secret(MASKED_API_KEY) },
    } as Partial<MCPServerConfig>);
    expect(savedConfig().headers).toEqual({});
  });

  describe.each(['stdio', 'websocket'] as const)('unused legacy headers on %s', (transport) => {
    it.each(['edit', 'rename'] as const)('allows an ordinary %s without activating the unused header', async (edit) => {
      mockLoadServerConfigs.mockResolvedValue([{ ...storedServer, transport, command: 'synthetic', websocketUrl: 'wss://saved.example' }]);
      const result = await service.updateServerConfig('saved', edit === 'rename' ? { name: 'renamed' } : { disabled: false, env: {} });
      expect(result).toMatchObject({ transport, name: edit === 'rename' ? 'renamed' : 'saved' });
      expect(savedConfig().headers.Authorization).toEqual(secret('encrypted:SYNTHETIC_SAVED_HEADER'));
      expect(mockEncryptApiKey).not.toHaveBeenCalled();
      expect(seams.handleConnectionStateChange).toHaveBeenCalledTimes(1);
    });

    it.each(['streamable', 'sse'] as const)('refuses inherited secret headers when changing to %s', async (target) => {
      mockLoadServerConfigs.mockResolvedValue([{ ...storedServer, transport }]);
      const result = await service.updateServerConfig('saved', { transport: target, serverUrl: 'https://other.example/mcp' } as Partial<MCPServerConfig>);
      expect(result).toEqual({ success: false, error: MCP_HEADER_DESTINATION_CHANGED, statusCode: 400 });
      expect(mockSaveConfig).not.toHaveBeenCalled();
      expect(seams.handleConnectionStateChange).not.toHaveBeenCalled();
    });
  });
});
