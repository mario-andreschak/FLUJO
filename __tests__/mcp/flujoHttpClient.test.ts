import { flujoBaseUrl, flujoRequest, toolRoute } from '../../mcp-servers/flujo/src/client';

describe('standalone flujo HTTP client', () => {
  const originalBaseUrl = process.env.FLUJO_BASE_URL;
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.FLUJO_BASE_URL;
    else process.env.FLUJO_BASE_URL = originalBaseUrl;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('defaults to the standard local URL and honors a custom runtime URL', () => {
    delete process.env.FLUJO_BASE_URL;
    expect(flujoBaseUrl()).toBe('http://127.0.0.1:4200');
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4317/';
    expect(flujoBaseUrl()).toBe('http://127.0.0.1:4317');
  });

  it('maps every tool group to a narrow domain endpoint', () => {
    expect(toolRoute('execute_flow')).toBe('/api/mcp/flujo/flows');
    expect(toolRoute('restart_mcp_server')).toBe('/api/mcp/flujo/servers');
    expect(toolRoute('create_planned_execution')).toBe('/api/mcp/flujo/automation');
    expect(toolRoute('kv_set')).toBe('/api/mcp/flujo/state');
    expect(toolRoute('create_flow')).toBe('/api/mcp/flujo/authoring');
    expect(() => toolRoute('arbitrary_internal_dispatch')).toThrow('Unknown FLUJO tool');
  });

  it('uses FLUJO_BASE_URL and preserves MCP result shapes', async () => {
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4567';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'done' }] }),
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(flujoRequest('callTool', {
      name: 'execute_flow',
      args: { flow: 'demo', input: 'hello' },
    })).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/api/mcp/flujo/flows',
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    );
  });

  it('surfaces intentional API errors without leaking response bodies', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 423,
      text: async () => JSON.stringify({ error: 'Storage is locked' }),
    }) as typeof fetch;

    await expect(flujoRequest('listTools')).rejects.toThrow('Storage is locked');
  });
});
