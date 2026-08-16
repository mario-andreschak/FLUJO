import { NextRequest } from 'next/server';

const assertLocalRequestMock = jest.fn<
  Response | null,
  [Request, { strictLoopback?: boolean }?]
>();
const getClientMock = jest.fn();
const disconnectServerMock = jest.fn();
const connectServerMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (request: Request, options?: { strictLoopback?: boolean }) =>
    assertLocalRequestMock(request, options),
}));

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    getClient: (...args: unknown[]) => getClientMock(...args),
    disconnectServer: (...args: unknown[]) => disconnectServerMock(...args),
    connectServer: (...args: unknown[]) => connectServerMock(...args),
  },
}));

import { POST } from '@/app/api/mcp/cancel/route';

function request(query: string): NextRequest {
  return new NextRequest(`https://flujo.example.com/api/mcp/cancel?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'test cancellation' }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  assertLocalRequestMock.mockReturnValue(null);
  getClientMock.mockReturnValue({ connected: true });
  disconnectServerMock.mockResolvedValue({ success: true });
  connectServerMock.mockResolvedValue({ success: true });
});

describe('MCP force-cancel Persona boundary', () => {
  it('requires strict loopback before disconnecting an entire MCP server', async () => {
    assertLocalRequestMock.mockReturnValueOnce(new Response('forbidden', { status: 403 }));

    const response = await POST(request('serverName=shared-server'));

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(
      expect.any(NextRequest),
      { strictLoopback: true },
    );
    expect(getClientMock).not.toHaveBeenCalled();
    expect(disconnectServerMock).not.toHaveBeenCalled();
    expect(connectServerMock).not.toHaveBeenCalled();
  });

  it('keeps token-scoped requests compatible without a global disconnect', async () => {
    const response = await POST(request('serverName=shared-server&token=call-1'));

    expect(response.status).toBe(200);
    expect(assertLocalRequestMock).not.toHaveBeenCalled();
    expect(getClientMock).toHaveBeenCalledWith('shared-server');
    expect(disconnectServerMock).not.toHaveBeenCalled();
    expect(connectServerMock).not.toHaveBeenCalled();
  });

  it('disconnects and reconnects only after the strict guard allows it', async () => {
    const response = await POST(request('serverName=shared-server'));

    expect(response.status).toBe(200);
    expect(disconnectServerMock).toHaveBeenCalledWith('shared-server');
    expect(connectServerMock).toHaveBeenCalledWith('shared-server');
  });
});
