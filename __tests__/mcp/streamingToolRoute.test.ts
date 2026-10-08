const callToolMock = jest.fn();
const callToolFromAppMock = jest.fn();

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: (...args: unknown[]) => callToolMock(...args),
    callToolFromApp: (...args: unknown[]) => callToolFromAppMock(...args),
  },
}));

import { POST } from '@/app/api/mcp/servers/[name]/tools/[toolName]/stream/route';
import { makeLocalRequest } from '../utils/localRequest';

const context = (name: string, toolName: string) => ({
  params: Promise.resolve({ name, toolName }),
});

function eventPayloads(body: string, eventName: string): unknown[] {
  return body
    .split('\n\n')
    .filter((frame) => frame.startsWith(`event: ${eventName}\n`))
    .map((frame) => {
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      return JSON.parse(data?.slice(6) ?? 'null');
    });
}

beforeEach(() => {
  callToolMock.mockReset();
  callToolFromAppMock.mockReset();
});

describe('streaming MCP tool route', () => {
  it('forwards app progress and streams the complete result in lossless chunks', async () => {
    const text = 'full-result-'.repeat(10_000);
    callToolFromAppMock.mockImplementation(async (...args: unknown[]) => {
      const onProgress = args[6] as (progress: unknown) => void;
      onProgress({ progress: 1, message: 'working' });
      return { success: true, data: { content: [{ type: 'text', text }] } };
    });

    const response = await POST(
      makeLocalRequest({
        body: {
          args: { value: 1 },
          source: 'app',
          ownerScope: 'conversation:chat-1',
        },
      }),
      context('frame-server', 'refresh'),
    );
    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(callToolFromAppMock).toHaveBeenCalledWith(
      'frame-server',
      'refresh',
      { value: 1 },
      undefined,
      expect.any(AbortSignal),
      'conversation:chat-1',
      expect.any(Function),
    );
    expect(eventPayloads(body, 'progress')).toEqual([
      { progress: 1, message: 'working' },
    ]);
    const chunks = eventPayloads(body, 'result-chunk')
      .map((value) => (value as { chunk: string }).chunk);
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(chunks.join(''))).toEqual({
      success: true,
      data: { content: [{ type: 'text', text }] },
    });
    expect(eventPayloads(body, 'done')).toEqual([{}]);
  });

  it('uses the host path without acquiring a second lease in the route', async () => {
    callToolMock.mockResolvedValue({ success: true, data: { content: [] } });
    const response = await POST(
      makeLocalRequest({ body: { args: {} } }),
      context('srv', 'read'),
    );
    await response.text();

    expect(callToolMock).toHaveBeenCalledWith(
      'srv',
      'read',
      {},
      undefined,
      expect.any(Function),
      undefined,
      expect.any(AbortSignal),
    );
    expect(callToolFromAppMock).not.toHaveBeenCalled();
  });

  it('propagates a disconnected client to the in-flight MCP tool signal', async () => {
    const requestAbort = new AbortController();
    let toolSignal: AbortSignal | undefined;
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => { toolStarted = resolve; });
    let toolAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { toolAborted = resolve; });

    callToolMock.mockImplementation((...args: unknown[]) => {
      toolSignal = args[6] as AbortSignal;
      toolStarted();
      return new Promise((resolve) => {
        toolSignal?.addEventListener('abort', () => {
          toolAborted();
          resolve({ success: false, error: 'cancelled', errorType: 'cancelled' });
        }, { once: true });
      });
    });

    const request = makeLocalRequest({ body: { args: {} } });
    request.signal = requestAbort.signal;
    const response = await POST(request, context('srv', 'slow-tool'));
    await started;

    expect(toolSignal?.aborted).toBe(false);
    requestAbort.abort();
    await aborted;
    expect(toolSignal?.aborted).toBe(true);

    // Let the route's async producer observe cancellation and close its body.
    await response.text();
  });
});
