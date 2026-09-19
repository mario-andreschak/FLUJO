import { callStreamingTool } from '@/frontend/services/mcp/streamingToolCall';

function chunkedResponse(text: string, splitPoints: number[]): Response {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const end of [...splitPoints, text.length]) {
    chunks.push(encoder.encode(text.slice(start, end)));
    start = end;
  }
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('callStreamingTool', () => {
  const originalFetch = global.fetch;
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalWorkerDescriptor) {
      Object.defineProperty(globalThis, 'Worker', originalWorkerDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'Worker');
    }
    jest.restoreAllMocks();
  });

  it('parses SSE fields split across arbitrary transport chunks', async () => {
    const result = { success: true, data: { content: [{ type: 'text', text: 'hello' }] } };
    const json = JSON.stringify(result);
    const wire = [
      'event: progress\n',
      'data: {"progress":1,"message":"still working"}\n\n',
      'event: result-start\n',
      'data: {}\n\n',
      'event: result-chunk\n',
      `data: ${JSON.stringify({ chunk: json.slice(0, 7) })}\n\n`,
      'event: result-chunk\n',
      `data: ${JSON.stringify({ chunk: json.slice(7) })}\n\n`,
      'event: result-end\n',
      'data: {}\n\n',
      'event: done\n',
      'data: {}\n\n',
    ].join('');
    global.fetch = jest.fn(async () => chunkedResponse(wire, [3, 19, 41, 77, 113]));

    const progress = jest.fn();
    await expect(callStreamingTool('srv', 'tool', {}, { onProgress: progress }))
      .resolves.toMatchObject(result);
    expect(progress).toHaveBeenCalledWith({ progress: 1, message: 'still working' });
  });

  it('assembles and parses streamed result chunks in a browser worker', async () => {
    const result = {
      success: true,
      data: { content: [{ type: 'text', text: 'worker-delivered result' }] },
    };
    const json = JSON.stringify(result);
    const wire = [
      'event: result-start\n',
      'data: {}\n\n',
      'event: result-chunk\n',
      `data: ${JSON.stringify({ chunk: json.slice(0, 11) })}\n\n`,
      'event: result-chunk\n',
      `data: ${JSON.stringify({ chunk: json.slice(11) })}\n\n`,
      'event: result-end\n',
      'data: {}\n\n',
      'event: done\n',
      'data: {}\n\n',
    ].join('');

    class WorkerMock {
      static instances: WorkerMock[] = [];
      readonly terminate = jest.fn();
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(
        readonly url: string,
        readonly options?: WorkerOptions,
      ) {
        WorkerMock.instances.push(this);
      }

      postMessage(message: { requestId: string; chunks: string[] }) {
        queueMicrotask(() => this.onmessage?.({
          data: {
            type: 'parsed',
            requestId: message.requestId,
            value: JSON.parse(message.chunks.join('')),
          },
        } as MessageEvent));
      }
    }

    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      writable: true,
      value: WorkerMock,
    });
    global.fetch = jest.fn(async () => chunkedResponse(wire, [2, 31, 74, 121]));

    await expect(callStreamingTool('srv', 'tool', {})).resolves.toMatchObject(result);
    expect(WorkerMock.instances).toHaveLength(1);
    expect(WorkerMock.instances[0].url).toBe('/workers/tool-result-worker.js');
    expect(WorkerMock.instances[0].options).toEqual({ name: 'flujo-tool-result-parser' });
    expect(WorkerMock.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
});
