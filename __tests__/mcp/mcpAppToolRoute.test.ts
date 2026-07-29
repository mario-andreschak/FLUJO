const callToolMock = jest.fn();
const callToolFromAppMock = jest.fn();

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: (...args: unknown[]) => callToolMock(...args),
    callToolFromApp: (...args: unknown[]) => callToolFromAppMock(...args),
  },
}));

import { POST } from '@/app/api/mcp/servers/[name]/tools/[toolName]/route';
import { makeLocalRequest } from '../utils/localRequest';

const context = (name: string, toolName: string) => ({
  params: Promise.resolve({ name, toolName }),
});

beforeEach(() => {
  callToolMock.mockReset();
  callToolFromAppMock.mockReset();
});

describe('MCP App tool-call REST routing', () => {
  it('routes app-originated calls through visibility enforcement on the path server', async () => {
    callToolFromAppMock.mockResolvedValue({ success: true, data: { content: [] } });

    const response = await POST(
      makeLocalRequest({
        body: {
          args: { value: 1 },
          source: 'app',
          // Must be ignored: the route path is the app's authoritative server.
          serverName: 'other-server',
        },
      }),
      context('frame-server', 'refresh')
    );

    expect(response.status).toBe(200);
    expect(callToolFromAppMock).toHaveBeenCalledWith(
      'frame-server',
      'refresh',
      { value: 1 },
      undefined,
      expect.any(AbortSignal),
    );
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('keeps ordinary calls on the model/manual path', async () => {
    callToolMock.mockResolvedValue({ success: true, data: { content: [] } });

    const response = await POST(
      makeLocalRequest({ body: { args: {} } }),
      context('srv', 'read')
    );

    expect(response.status).toBe(200);
    expect(callToolMock).toHaveBeenCalledWith('srv', 'read', {}, undefined);
    expect(callToolFromAppMock).not.toHaveBeenCalled();
  });
});
