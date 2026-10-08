import {
  flujoRequest,
  flujoWorkspace,
} from '../../mcp-servers/flujo/src/client';

describe('standalone mcp-flujo workspace propagation', () => {
  const originalFetch = global.fetch;
  const originalWorkspace = process.env.FLUJO_WORKSPACE;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalWorkspace === undefined) delete process.env.FLUJO_WORKSPACE;
    else process.env.FLUJO_WORKSPACE = originalWorkspace;
  });

  it('validates FLUJO_WORKSPACE and sends it on every FLUJO request', async () => {
    process.env.FLUJO_WORKSPACE = 'team-a';
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ tools: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    global.fetch = fetchMock as typeof fetch;

    expect(flujoWorkspace()).toBe('team-a');
    await flujoRequest('listTools');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4200/api/mcp/flujo/tools',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-flujo-workspace': 'team-a' }),
      }),
    );

    process.env.FLUJO_WORKSPACE = '../escape';
    expect(flujoWorkspace()).toBe('default-workspace');
  });
});
