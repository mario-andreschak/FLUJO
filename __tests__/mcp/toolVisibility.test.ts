jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (value: unknown) => value),
}));

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  callTool,
  listServerTools,
} from '@/backend/services/mcp/tools';
import {
  checkToolCallVisibility,
  getToolVisibility,
} from '@/backend/services/mcp/appsProtocol';

type Visibility = unknown;

function serverTool(name: string, visibility?: Visibility, declareVisibility = true) {
  const ui = declareVisibility ? { visibility } : {};
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object' },
    _meta: { ui },
  };
}

function clientWithTools(tools: ReturnType<typeof serverTool>[]) {
  const listToolsMock = jest.fn(async () => ({ tools }));
  const callToolMock = jest.fn(async () => ({ content: [] }));
  const client = {
    listTools: listToolsMock,
    callTool: callToolMock,
  } as unknown as Client;
  return { client, listToolsMock, callToolMock };
}

describe('MCP Apps tool visibility', () => {
  const defaultTool = serverTool('default', undefined, false);
  const modelOnly = serverTool('model-only', ['model']);
  const appOnly = serverTool('app-only', ['app']);
  const hidden = serverTool('hidden', []);
  const malformed = serverTool('malformed', ['app', 'unexpected']);

  it('defaults omitted visibility to both model and app', () => {
    expect(getToolVisibility(defaultTool as never)).toEqual(['model', 'app']);
  });

  it('fails closed for an explicitly malformed visibility declaration', () => {
    expect(getToolVisibility(malformed as never)).toEqual([]);
    expect(getToolVisibility({ _meta: { ui: null } } as never)).toEqual([]);
    expect(getToolVisibility({ _meta: { ui: 'invalid' } } as never)).toEqual([]);
  });

  it('filters model-facing listings without discarding raw app-only definitions', async () => {
    const tools = [defaultTool, modelOnly, appOnly, hidden, malformed];
    const { client } = clientWithTools(tools);

    const modelResult = await listServerTools(client, 'srv');
    const appResult = await listServerTools(client, 'srv', 'app');
    const rawResult = await listServerTools(client, 'srv', 'all');

    expect(modelResult.tools.map((tool) => tool.name)).toEqual(['default', 'model-only']);
    expect(appResult.tools.map((tool) => tool.name)).toEqual(['default', 'app-only']);
    expect(rawResult.tools.map((tool) => tool.name)).toEqual([
      'default',
      'model-only',
      'app-only',
      'hidden',
      'malformed',
    ]);
  });

  it('preserves current standard tool display, schema, and execution metadata', async () => {
    const definition = {
      name: 'export',
      title: 'Export records',
      description: 'Export data.',
      icons: [{ src: 'https://example.test/icon.png', mimeType: 'image/png' }],
      inputSchema: { type: 'object' as const },
      outputSchema: { type: 'object' as const, properties: { url: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: 'optional' as const },
      _meta: { ui: { resourceUri: 'ui://export' } },
    };
    const client = { listTools: jest.fn(async () => ({ tools: [definition] })) } as unknown as Client;

    const result = await listServerTools(client, 'srv', 'all');

    expect(result.tools[0]).toEqual(definition);
  });

  it('rejects an app call when the same-server definition lacks app visibility', async () => {
    const { client, callToolMock } = clientWithTools([modelOnly]);

    const result = await callTool(
      client,
      'own-server',
      'model-only',
      {},
      undefined,
      undefined,
      undefined,
      'app'
    );

    expect(result).toMatchObject({
      success: false,
      statusCode: 403,
    });
    expect(result.error).toContain('own-server');
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('rejects a model call when the same-server definition is app-only', async () => {
    const { client, callToolMock } = clientWithTools([appOnly]);

    const result = await callTool(
      client,
      'own-server',
      'app-only',
      {},
      undefined,
      undefined,
      undefined,
      'model',
    );

    expect(result).toMatchObject({
      success: false,
      statusCode: 403,
    });
    expect(result.error).toContain('the model');
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('leaves an explicit host/manual call outside model/app visibility policy', async () => {
    const { client, listToolsMock, callToolMock } = clientWithTools([hidden]);

    const result = await callTool(client, 'own-server', 'hidden', {});

    expect(result.success).toBe(true);
    expect(listToolsMock).not.toHaveBeenCalled();
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['omitted visibility', defaultTool],
    ['explicit app visibility', appOnly],
  ])('allows an app call with %s', async (_label, tool) => {
    const { client, listToolsMock, callToolMock } = clientWithTools([tool]);

    const result = await callTool(
      client,
      'own-server',
      tool.name,
      { value: 1 },
      undefined,
      undefined,
      undefined,
      'app'
    );

    expect(result.success).toBe(true);
    expect(listToolsMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a missing tool from a visibility denial', () => {
    expect(checkToolCallVisibility([appOnly] as never, 'srv', 'missing', 'app')).toMatchObject({
      allowed: false,
      statusCode: 404,
    });
  });
});
