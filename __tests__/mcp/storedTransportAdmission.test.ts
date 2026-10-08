jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(), saveItem: jest.fn() }));
jest.mock('@/utils/workspace', () => ({
  getWorkspaceDataDir: () => process.cwd(),
  remapLegacyDefaultWorkspaceReference: (value: string) => value,
}));
jest.mock('simple-git', () => ({ __esModule: true, simpleGit: jest.fn() }));

import { loadItem, saveItem } from '@/utils/storage/backend';
import { simpleGit } from 'simple-git';
import { loadServerConfigs, saveConfig } from '@/backend/services/mcp/config';
import { resolveRuntimeHomeIsolation } from '@/backend/services/mcp/runtimeHomeIsolation';
import { MCP_TRANSPORT_INVALID } from '@/backend/services/mcp/transportAdmission';
import type { MCPServerConfig } from '@/shared/types/mcp';

beforeEach(() => { jest.clearAllMocks(); });

it('tags legacy stored stdio explicitly so its runtime-home policy runs', async () => {
  const record = { command: 'node', args: ['server.js'], runtimeHomeMode: 'isolated' };
  jest.mocked(loadItem).mockResolvedValue({ legacy: record });
  const loaded = await loadServerConfigs();
  expect(Array.isArray(loaded)).toBe(true);
  const config = (loaded as MCPServerConfig[])[0];
  expect(config.transport).toBe('stdio');
  expect(await resolveRuntimeHomeIsolation(config, {})).toBe(true);
  expect(record).not.toHaveProperty('transport');
  expect(saveItem).not.toHaveBeenCalled();
});

it.each([null, false, 0, '', 'unknown-secret', {}, ['stdio']])(
  'refuses a malformed stored tag before git lookup or persistence: %p', async (transport) => {
    jest.mocked(loadItem).mockResolvedValue({ server: { transport, command: 'node', rootPath: 'mcp-servers/server' } });
    expect(await loadServerConfigs()).toEqual({ success: false, error: MCP_TRANSPORT_INVALID, statusCode: 400 });
    expect(simpleGit).not.toHaveBeenCalled();
    expect(saveItem).not.toHaveBeenCalled();
  },
);

it('refuses the complete save before writing any record if one transport is invalid', async () => {
  const configs = new Map<string, MCPServerConfig>([
    ['good', { transport: 'stdio', command: 'node' } as MCPServerConfig],
    ['bad', { transport: 'unknown-secret', command: 'node' } as unknown as MCPServerConfig],
  ]);
  expect(await saveConfig(configs)).toEqual({ success: false, error: MCP_TRANSPORT_INVALID, statusCode: 400 });
  expect(saveItem).not.toHaveBeenCalled();
});
