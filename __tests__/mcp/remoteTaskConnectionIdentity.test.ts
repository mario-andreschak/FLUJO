/**
 * Which connection a remote MCP task may be followed on, now that every task is
 * recorded (#1449). FLUJO's registered connection must still be the server's
 * current one; a caller's own connection, which FLUJO never registered, keeps
 * its task where it started.
 */
const mockGetClient = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    getClient: (name: string) => mockGetClient(name),
    loadServerConfigs: async () => [{ name: 'srv', transport: 'streamable', serverUrl: 'https://tasks.example.test/mcp', disabled: false }],
  },
}));
jest.mock('@/backend/utils/resolveGlobalVars', () => ({ resolveGlobalVars: jest.fn(async (value: unknown) => value) }));
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => [{ name: 'srv', transport: 'streamable', serverUrl: 'https://tasks.example.test/mcp', disabled: false }]),
}));

import { callTool } from '@/backend/services/mcp/tools';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const cancelledTaskClient = () => {
  const request = jest.fn(async () => ({}));
  const client = {
    callTool: jest.fn(async () => ({ task: { taskId: 'task-1', status: 'cancelled' } })),
    request,
  } as unknown as Client;
  return { client, request };
};

describe('following a remote MCP task', () => {
  beforeEach(() => mockGetClient.mockReset());

  it('follows the task on a caller\'s own connection that FLUJO never registered', async () => {
    const { client } = cancelledTaskClient();
    mockGetClient.mockReturnValue(undefined);

    await expect(callTool(client, 'srv', 'demo', {})).resolves.toEqual({
      success: false,
      error: "Tool 'demo' task task-1 was cancelled by the server.",
      errorType: 'cancelled',
      toolName: 'demo',
      progressToken: 'task-1',
    });
  });

  it('refuses to go on when FLUJO\'s registered connection was replaced before the result', async () => {
    const { client, request } = cancelledTaskClient();
    const replacement = cancelledTaskClient().client;
    mockGetClient.mockReturnValueOnce(client).mockReturnValue(replacement);

    const result = await callTool(client, 'srv', 'demo', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('MCP task server connection identity changed');
    expect(request).not.toHaveBeenCalled();
  });
});
