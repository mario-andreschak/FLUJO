/**
 * Regression tests for callTool timeout + progress semantics.
 *
 * The MCP SDK times out EVERY request after 60s by default (McpError -32001,
 * "Request timed out") unless RequestOptions.timeout says otherwise. callTool
 * used to wrap client.callTool in its own Promise.race and never passed
 * options, so:
 *   - "no timeout" / timeout=-1 still died at the SDK's 60s default,
 *   - any timeout > 60s was unreachable.
 * callTool now delegates the timeout to the SDK ("no timeout" = the setTimeout
 * ceiling), enables resetTimeoutOnProgress, and forwards server progress
 * notifications to the caller.
 */

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

import { callTool } from '@/backend/services/mcp/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // Node's setTimeout ceiling

const makeClient = (impl?: jest.Mock) => {
  const callToolMock = impl ?? jest.fn(async () => ({ content: [] }));
  return { client: { callTool: callToolMock } as unknown as Client, callToolMock };
};

describe('callTool timeout handling', () => {
  it('passes "no timeout" (the setTimeout ceiling) to the SDK when no timeout is given', async () => {
    const { client, callToolMock } = makeClient();

    const result = await callTool(client, 'srv', 'demo', {});

    expect(result.success).toBe(true);
    const [params, , options] = callToolMock.mock.calls[0];
    expect(params).toEqual({ name: 'demo', arguments: {} });
    // No hand-rolled _meta.progressToken: the SDK attaches its own (the request
    // id) because onprogress is set — a foreign token would make the SDK drop
    // incoming progress notifications as "unknown token".
    expect(params._meta).toBeUndefined();
    expect(options.timeout).toBe(MAX_TIMEOUT_MS);
    expect(options.resetTimeoutOnProgress).toBe(true);
    expect(typeof options.onprogress).toBe('function');
  });

  it('treats timeout=-1 as no timeout', async () => {
    const { client, callToolMock } = makeClient();

    await callTool(client, 'srv', 'demo', {}, -1);

    const [, , options] = callToolMock.mock.calls[0];
    expect(options.timeout).toBe(MAX_TIMEOUT_MS);
  });

  it('converts a positive timeout from seconds to SDK milliseconds', async () => {
    const { client, callToolMock } = makeClient();

    await callTool(client, 'srv', 'demo', {}, 120);

    const [, , options] = callToolMock.mock.calls[0];
    expect(options.timeout).toBe(120_000);
  });

  it('maps the SDK timeout rejection (-32001) to the standardized 408 response', async () => {
    const { client } = makeClient(
      jest.fn(async () => {
        throw new McpError(ErrorCode.RequestTimeout, 'Request timed out', { timeout: 30_000 });
      })
    );

    const result = await callTool(client, 'srv', 'demo', {}, 30);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(408);
    expect(result.errorType).toBe('timeout');
    expect(result.error).toBe('Tool execution timed out after 30 seconds');
  });

  it('forwards SDK progress notifications to the onProgress callback', async () => {
    const { client, callToolMock } = makeClient(
      jest.fn(async (_params, _schema, options) => {
        options.onprogress({ progress: 3, total: 10, message: 'working' });
        return { content: [] };
      })
    );
    const onProgress = jest.fn();

    const result = await callTool(client, 'srv', 'demo', {}, undefined, onProgress);

    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({ progress: 3, total: 10, message: 'working' });
  });
});
