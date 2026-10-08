const mockLoadConfigs = jest.fn();
const mockSaveConfig = jest.fn();
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...args: unknown[]) => mockLoadConfigs(...args),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));
const mockResolveHeaders = jest.fn();
const mockFactory = jest.fn();
const mockReuse = jest.fn();
jest.mock('@/backend/services/mcp/connection', () => ({
  McpRuntimeAuthorityRetirementError: jest.requireActual('@/backend/services/mcp/connection').McpRuntimeAuthorityRetirementError,
  assertMcpRuntimeAuthorityRetired: jest.requireActual('@/backend/services/mcp/connection').assertMcpRuntimeAuthorityRetired,
  resolveConfigHeaders: (...args: unknown[]) => mockResolveHeaders(...args),
  createTransport: (...args: unknown[]) => mockFactory(...args),
  createNewClient: (...args: unknown[]) => mockFactory(...args),
  shouldRecreateClient: (...args: unknown[]) => mockReuse(...args),
  safelyCloseClient: jest.fn(),
}));
jest.mock('@/backend/services/mcp/betaClient', () => ({
  isMcpBetaProtocolEnabled: (...args: unknown[]) => mockFactory(...args),
  createBetaTransport: (...args: unknown[]) => mockFactory(...args),
  createNewBetaClient: (...args: unknown[]) => mockFactory(...args),
}));

import { MCPService } from '@/backend/services/mcp';
import { MCP_TRANSPORT_INVALID } from '@/backend/services/mcp/transportAdmission';
import type { MCPServerConfig } from '@/shared/types/mcp';

const denied = { success: false, error: MCP_TRANSPORT_INVALID, statusCode: 400 };
beforeEach(() => { jest.clearAllMocks(); mockLoadConfigs.mockResolvedValue([]); });
afterEach(() => { global.__mcp_clients?.clear(); });

it.each([undefined, null, false, 0, '', 'unknown-secret', ['stdio']])(
  'refuses malformed connection/test/update input before decrypting, factories, reuse or saves: %p',
  async (transport) => {
    const service = new MCPService();
    const config = { name: 'admission-test', transport, command: 'node' } as MCPServerConfig;
    const emit = jest.fn();
    expect(await service.connectServer(config)).toEqual(denied);
    expect(await service.testConnection(config, emit)).toEqual(denied);
    expect(await service.updateServerConfig('admission-test', config)).toEqual(denied);
    expect(mockLoadConfigs).not.toHaveBeenCalled();
    expect(mockResolveHeaders).not.toHaveBeenCalled();
    expect(mockFactory).not.toHaveBeenCalled();
    expect(mockReuse).not.toHaveBeenCalled();
    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  },
);

it('refuses an invalid loaded tag before reusing an existing client', async () => {
  const service = new MCPService();
  mockLoadConfigs.mockResolvedValue([{ name: 'admission-test', transport: 'unknown-secret', command: 'node' }]);
  global.__mcp_clients?.set('admission-test', {} as never);
  expect(await service.connectServer('admission-test')).toEqual(denied);
  expect(mockResolveHeaders).not.toHaveBeenCalled();
  expect(mockFactory).not.toHaveBeenCalled();
  expect(mockReuse).not.toHaveBeenCalled();
});
