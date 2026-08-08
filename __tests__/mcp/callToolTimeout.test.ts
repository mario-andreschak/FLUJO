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

  it('maps a caller-aborted request to the structured cancelled response', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = makeClient(
      jest.fn(async () => {
        throw new Error('The operation was aborted');
      })
    );

    const result = await callTool(
      client,
      'srv',
      'demo',
      {},
      undefined,
      undefined,
      controller.signal
    );

    expect(result).toEqual({
      success: false,
      error: "Tool 'demo' call was cancelled.",
      errorType: 'cancelled',
      toolName: 'demo',
    });
  });

  it('maps a server-cancelled MCP Task to the structured cancelled response', async () => {
    const { client } = makeClient(
      jest.fn(async () => ({
        task: {
          taskId: 'task-1',
          status: 'cancelled',
        },
      }))
    );

    const result = await callTool(client, 'srv', 'demo', {});

    // Every task-lifecycle failure response carries BOTH the correlating
    // progressToken (the remote task id) and the toolName, exactly like the
    // caller-abort response above — see clientTasks.terminalResponseFor.
    expect(result).toEqual({
      success: false,
      error: "Tool 'demo' task task-1 was cancelled by the server.",
      errorType: 'cancelled',
      toolName: 'demo',
      progressToken: 'task-1',
      toolName: 'demo',
    });
  });

  it('cancels an in-flight MCP Task with a fresh request when polling is aborted', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const callToolMock = jest.fn(async () => ({
        task: {
          taskId: 'task-running',
          status: 'working',
          pollInterval: 1_000,
        },
      }));
      const requestMock = jest.fn(async (
        request: { method: string },
        _schema?: unknown,
        _options?: unknown,
      ) => {
        if (request.method === 'tasks/get') {
          controller.abort();
          throw new Error('poll aborted');
        }
        return {};
      });
      const client = {
        __flujoBeta: true,
        callTool: callToolMock,
        request: requestMock,
      } as unknown as Client;

      const pending = callTool(
        client,
        'srv',
        'demo',
        {},
        undefined,
        undefined,
        controller.signal,
      );
      await jest.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.errorType).toBe('cancelled');
      const cancelCall = requestMock.mock.calls.find(
        ([request]) => request.method === 'tasks/cancel',
      );
      expect(cancelCall).toBeDefined();
      expect(cancelCall?.[0]).toEqual({
        method: 'tasks/cancel',
        params: { taskId: 'task-running' },
      });
      expect(cancelCall?.[2]).toEqual({ timeout: 10_000 });
      expect(cancelCall?.[2]).not.toHaveProperty('signal');
    } finally {
      jest.useRealTimers();
    }
  });
});
