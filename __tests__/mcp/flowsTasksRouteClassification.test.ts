import { POST } from '@/app/mcp-flows/route';
import { isLegacyFlowsMcpRequest, handleModernFlowsMcpRequest } from '@/backend/services/mcp/flowsTasksServer';
import { handleStatelessMcpRequest } from '@/backend/services/mcp/statelessHttpTransport';

// Isolate the actual route's stream-bound classifier and its dispatch choice.
// Owner/workspace admission and both actual transports are separately tested;
// this fixture proves the original body and legacy branch survive the probe.
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/services/mcp/proxyForward', () => ({
  isLocalRequest: jest.requireActual('@/utils/http/localRequest').isLocalRequest,
}));
jest.mock('@/backend/services/mcp/tasksProtocol', () => ({ mcpTasksServerEnabled: () => process.env.FLUJO_MCP_TASKS_SERVER === 'true' }));
jest.mock('@/backend/services/mcp/flowsTasksServer', () => ({
  isLegacyFlowsMcpRequest: jest.fn(jest.requireActual('@modelcontextprotocol/server').isLegacyRequest),
  handleModernFlowsMcpRequest: jest.fn(async (request: Request) => Response.json({ branch: 'modern', body: await request.text() })),
}));
jest.mock('@/backend/services/mcp/statelessHttpTransport', () => ({
  handleStatelessMcpRequest: jest.fn(async (_server, request: Request) => Response.json({ branch: 'legacy', body: await request.text() })),
}));
jest.mock('@/backend/services/mcp/flowTools', () => ({ flowToolsListTools: jest.fn(), flowToolsCallTool: jest.fn() }));
jest.mock('@/backend/services/mcp/flowAuthoringTools', () => ({
  authoringToolDefinitions: jest.fn(), authoringCallTool: jest.fn(), isAuthoringTool: jest.fn(),
}));

const limit = 256 * 1024;
function incoming(body: string | ReadableStream<Uint8Array>, length?: string) {
  return new Request('http://localhost:4200/mcp-flows', {
    method: 'POST', body, duplex: 'half',
    headers: { host: 'localhost:4200', 'content-type': 'application/json',
      ...(length === undefined ? {} : { 'content-length': length }) },
  } as RequestInit);
}
function stream(chunks: Uint8Array[]) {
  let reads = 0; const cancelled = jest.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); },
    cancel: cancelled,
  }, { highWaterMark: 0 });
  return { body, cancelled, reads: () => reads };
}
const legacy = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', clientInfo: { name: 'legacy', version: '1' }, capabilities: {},
} });
const modern = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'modern', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
} } });

describe('Flows route bounded body-primary classification', () => {
  const savedFlag = process.env.FLUJO_MCP_TASKS_SERVER;
  beforeEach(() => { jest.clearAllMocks(); process.env.FLUJO_MCP_TASKS_SERVER = 'true'; });
  afterAll(() => { if (savedFlag === undefined) delete process.env.FLUJO_MCP_TASKS_SERVER;
    else process.env.FLUJO_MCP_TASKS_SERVER = savedFlag; });

  test.each([undefined, '1'])('bounds an oversized chunked body despite Content-Length=%s', async length => {
    const source = stream([new Uint8Array(limit), new Uint8Array(1), new Uint8Array(1024)]);
    const response = await POST(incoming(source.body, length));
    expect(response.status).toBe(413);
    expect(isLegacyFlowsMcpRequest).not.toHaveBeenCalled();
    expect(handleModernFlowsMcpRequest).not.toHaveBeenCalled();
    expect(handleStatelessMcpRequest).not.toHaveBeenCalled();
    await new Promise(resolve => setImmediate(resolve));
    expect(source.cancelled).toHaveBeenCalledTimes(1);
    expect(source.reads()).toBeLessThanOrEqual(3);
  });

  test('rejects an oversized declared length without probing or reading the body', async () => {
    const source = stream([new Uint8Array(1)]);
    expect((await POST(incoming(source.body, String(limit + 1)))).status).toBe(413);
    expect(source.reads()).toBe(0);
    expect(isLegacyFlowsMcpRequest).not.toHaveBeenCalled();
    await source.body.cancel();
  });

  test('accepts the exact byte boundary and preserves the body for the modern handler', async () => {
    const body = modern + ' '.repeat(limit - Buffer.byteLength(modern));
    const response = await POST(incoming(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ branch: 'modern', body });
    expect(isLegacyFlowsMcpRequest).toHaveBeenCalledTimes(1);
    expect(handleStatelessMcpRequest).not.toHaveBeenCalled();
  });

  test('retains legacy dispatch and its untouched original JSON when enabled', async () => {
    const response = await POST(incoming(legacy));
    expect(await response.json()).toEqual({ branch: 'legacy', body: legacy });
    expect(isLegacyFlowsMcpRequest).toHaveBeenCalledTimes(1);
    expect(handleModernFlowsMcpRequest).not.toHaveBeenCalled();
  });

  test('disabled feature retains the old legacy dispatch without the new probe', async () => {
    process.env.FLUJO_MCP_TASKS_SERVER = 'false';
    const body = legacy + ' '.repeat(limit);
    const response = await POST(incoming(body, '1'));
    expect(await response.json()).toEqual({ branch: 'legacy', body });
    expect(isLegacyFlowsMcpRequest).not.toHaveBeenCalled();
    expect(handleModernFlowsMcpRequest).not.toHaveBeenCalled();
  });
});
