/**
 * Unit tests for the resources/prompts backend functions (#15).
 *
 * These drive the real resources.ts / prompts.ts against a fake MCP Client, so they pin the
 * behaviour FLUJO owns: graceful handling of a missing client, swallowing "method not found"
 * for servers that don't implement the capability, and resolving global variables in
 * resource URIs / prompt arguments before they hit the SDK.
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// resolveGlobalVars is the seam where flow variables get substituted; assert it runs by
// having it uppercase a sentinel so we can see the resolved value reach the client.
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) =>
    typeof v === 'string'
      ? v.replace('${var}', 'RESOLVED')
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, string>).map(([k, val]) => [
              k,
              typeof val === 'string' ? val.replace('${var}', 'RESOLVED') : val,
            ])
          )
        : v
  ),
}));

import {
  listServerResources,
  listServerResourceTemplates,
  readResource,
} from '@/backend/services/mcp/resources';
import { listServerPrompts, getPrompt } from '@/backend/services/mcp/prompts';

const makeClient = (over: Record<string, unknown> = {}) =>
  ({
    listResources: jest.fn(async () => ({ resources: [] })),
    listResourceTemplates: jest.fn(async () => ({ resourceTemplates: [] })),
    readResource: jest.fn(async () => ({ contents: [] })),
    listPrompts: jest.fn(async () => ({ prompts: [] })),
    getPrompt: jest.fn(async () => ({ messages: [] })),
    ...over,
  }) as any;

describe('listServerResources', () => {
  it('returns an error (not a throw) when there is no client', async () => {
    const result = await listServerResources(undefined, 'srv');
    expect(result.resources).toEqual([]);
    expect(result.error).toBe('Server not connected');
  });

  it('returns the server resources on success', async () => {
    const client = makeClient({
      listResources: jest.fn(async () => ({ resources: [{ uri: 'file://a', name: 'A' }] })),
    });
    const result = await listServerResources(client, 'srv');
    expect(result.error).toBeUndefined();
    expect(result.resources).toHaveLength(1);
  });

  it('swallows method-not-found (server has no resources capability) as an empty list', async () => {
    const client = makeClient({
      listResources: jest.fn(async () => {
        throw new McpError(ErrorCode.MethodNotFound, 'Method not found');
      }),
    });
    const result = await listServerResources(client, 'srv');
    expect(result.resources).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('reports a real failure as an error', async () => {
    const client = makeClient({
      listResources: jest.fn(async () => {
        throw new Error('boom');
      }),
    });
    const result = await listServerResources(client, 'srv');
    expect(result.resources).toEqual([]);
    expect(result.error).toContain('boom');
  });
});

describe('listServerResourceTemplates', () => {
  it('swallows method-not-found as an empty list', async () => {
    const client = makeClient({
      listResourceTemplates: jest.fn(async () => {
        throw new McpError(ErrorCode.MethodNotFound, 'Method not found');
      }),
    });
    const result = await listServerResourceTemplates(client, 'srv');
    expect(result.resourceTemplates).toEqual([]);
    expect(result.error).toBeUndefined();
  });
});

describe('readResource', () => {
  it('resolves global variables in the URI before reading', async () => {
    const readMock = jest.fn(async () => ({ contents: [{ uri: 'x', text: 'hi' }] }));
    const client = makeClient({ readResource: readMock });
    const result = await readResource(client, 'srv', 'file://${var}/path');
    expect(result.success).toBe(true);
    expect(readMock).toHaveBeenCalledWith({ uri: 'file://RESOLVED/path' });
  });

  it('returns success:false with a 404 when there is no client', async () => {
    const result = await readResource(undefined, 'srv', 'file://a');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
  });

  it('maps an McpError into a failure response', async () => {
    const client = makeClient({
      readResource: jest.fn(async () => {
        throw new McpError(ErrorCode.InvalidParams, 'bad uri');
      }),
    });
    const result = await readResource(client, 'srv', 'file://a');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
  });
});

describe('listServerPrompts', () => {
  it('swallows method-not-found as an empty list', async () => {
    const client = makeClient({
      listPrompts: jest.fn(async () => {
        throw new McpError(ErrorCode.MethodNotFound, 'Method not found');
      }),
    });
    const result = await listServerPrompts(client, 'srv');
    expect(result.prompts).toEqual([]);
    expect(result.error).toBeUndefined();
  });
});

describe('getPrompt', () => {
  it('resolves global variables in the arguments before fetching', async () => {
    const getMock = jest.fn(async () => ({ messages: [] }));
    const client = makeClient({ getPrompt: getMock });
    await getPrompt(client, 'srv', 'greet', { who: '${var}' });
    expect(getMock).toHaveBeenCalledWith({ name: 'greet', arguments: { who: 'RESOLVED' } });
  });

  it('omits arguments entirely when none are provided', async () => {
    const getMock = jest.fn(async () => ({ messages: [] }));
    const client = makeClient({ getPrompt: getMock });
    await getPrompt(client, 'srv', 'greet');
    expect(getMock).toHaveBeenCalledWith({ name: 'greet', arguments: undefined });
  });
});
