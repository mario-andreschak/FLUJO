import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { handleStatelessMcpRequest } from '@/backend/services/mcp/statelessHttpTransport';

function initializeRequest(id: number): Request {
  return new Request('http://localhost/mcp-flows', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'transport-test', version: '1.0.0' },
      },
    }),
  });
}

describe('handleStatelessMcpRequest', () => {
  it('handles a request natively and closes the server-owned transport once complete', async () => {
    const server = new Server(
      { name: 'transport-test', version: '1.0.0' },
      { capabilities: {} },
    );
    const closeSpy = jest.spyOn(server, 'close');

    const response = await handleStatelessMcpRequest(server, initializeRequest(1));
    const body = await response.json() as {
      id: number;
      result: { serverInfo: { name: string } };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe('transport-test');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps repeated response cancellation isolated across fresh stateless transports', async () => {
    for (let id = 1; id <= 25; id += 1) {
      const server = new Server(
        { name: 'transport-test', version: '1.0.0' },
        { capabilities: {} },
      );
      const response = await handleStatelessMcpRequest(server, initializeRequest(id));

      await expect(response.body?.cancel()).resolves.toBeUndefined();
    }
  });
});
