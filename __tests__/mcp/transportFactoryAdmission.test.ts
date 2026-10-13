jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(), saveItem: jest.fn() }));

import { loadItem } from '@/utils/storage/backend';
import { createTransport, resolveStdioLaunch } from '@/backend/services/mcp/connection';
import { createBetaTransport } from '@/backend/services/mcp/betaClient';
import { resolveRuntimeHomeIsolation } from '@/backend/services/mcp/runtimeHomeIsolation';
import { MCP_TRANSPORT_INVALID } from '@/backend/services/mcp/transportAdmission';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';

it.each([undefined, null, false, 0, '', 'STDIO', 'unknown-secret', ['stdio']])(
  'refuses both real SDK factory paths and direct launch resolution before reading launch material: %p',
  async (transport) => {
    jest.clearAllMocks();
    const readMaterial = jest.fn(() => { throw new Error('launch material must remain unread'); });
    const config = Object.defineProperties({ name: 'admission-test', transport }, {
      command: { get: readMaterial }, env: { get: readMaterial },
      headers: { get: readMaterial }, launch: { get: readMaterial },
    }) as MCPServerConfig;
    expect(() => createTransport(config)).toThrow(MCP_TRANSPORT_INVALID);
    expect(() => createBetaTransport(config)).toThrow(MCP_TRANSPORT_INVALID);
    expect(() => resolveStdioLaunch(config as MCPStdioConfig)).toThrow(MCP_TRANSPORT_INVALID);
    await expect(resolveRuntimeHomeIsolation(config, { FLUJO_MCP_RUNTIME_HOME_ISOLATION: 'on' }))
      .rejects.toThrow(MCP_TRANSPORT_INVALID);
    expect(readMaterial).not.toHaveBeenCalled();
    expect(loadItem).not.toHaveBeenCalled();
  },
);
