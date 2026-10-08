'use client';

export interface StreamingToolProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface StreamingToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  statusCode?: number;
  errorType?: string;
  httpStatus?: number;
}

export interface StreamingToolCallOptions {
  timeout?: number;
  signal?: AbortSignal;
  source?: 'host' | 'app';
  ownerScope?: string;
  onProgress?: (progress: StreamingToolProgress) => void;
}

interface SseEvent {
  event: string;
  data: string;
}

function abortError(): Error {
  const error = new Error('Tool call cancelled');
  error.name = 'AbortError';
  return error;
}

async function parseJsonChunksOffThread(
  chunks: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw abortError();
  if (typeof Worker === 'undefined') {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (signal?.aborted) throw abortError();
    return JSON.parse(chunks.join(''));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker('/workers/tool-result-worker.js', {
      name: 'flujo-tool-result-parser',
    });
    const requestId = crypto.randomUUID();
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    worker.onmessage = (event: MessageEvent<{
      type?: string;
      requestId?: string;
      value?: unknown;
      error?: string;
    }>) => {
      if (event.data.requestId !== requestId) return;
      cleanup();
      if (event.data.type === 'error') {
        reject(new Error(event.data.error || 'Could not parse streamed tool result'));
      } else {
        resolve(event.data.value);
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'Tool-result parser worker failed'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({ type: 'parse-chunks', requestId, chunks });
  });
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const dispatch = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return undefined;
    }
    const event = { event: eventName, data: dataLines.join('\n') };
    eventName = 'message';
    dataLines = [];
    return event;
  };

  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd !== -1) {
        let line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const event = dispatch();
          if (event) yield event;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let fieldValue = colon === -1 ? '' : line.slice(colon + 1);
          if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
          if (field === 'event') eventName = fieldValue || 'message';
          if (field === 'data') dataLines.push(fieldValue);
        }
        lineEnd = buffer.indexOf('\n');
      }
      if (done) break;
    }
    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const event = dispatch();
    if (event) yield event;
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function asToolResult(value: unknown, httpStatus: number): StreamingToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Streaming tool endpoint returned an invalid result');
  }
  const result = value as StreamingToolResult;
  return { ...result, httpStatus: result.statusCode ?? httpStatus };
}

export async function callStreamingTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  options: StreamingToolCallOptions = {},
): Promise<StreamingToolResult> {
  const response = await fetch(
    `/api/mcp/servers/${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}/stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        args,
        timeout: options.timeout,
        source: options.source,
        ownerScope: options.ownerScope,
      }),
      signal: options.signal,
    },
  );

  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { error?: string };
    return {
      success: false,
      error: failure.error || `Tool call failed (HTTP ${response.status})`,
      statusCode: response.status,
      httpStatus: response.status,
    };
  }
  if (!response.body) throw new Error('Streaming tool endpoint returned no body');

  const resultChunks: string[] = [];
  let result: StreamingToolResult | undefined;
  for await (const frame of readSse(response.body, options.signal)) {
    if (frame.event === 'progress') {
      options.onProgress?.(JSON.parse(frame.data) as StreamingToolProgress);
    } else if (frame.event === 'result-start') {
      resultChunks.length = 0;
    } else if (frame.event === 'result-chunk') {
      const value = JSON.parse(frame.data) as { chunk?: unknown };
      if (typeof value.chunk !== 'string') throw new Error('Invalid tool-result chunk');
      resultChunks.push(value.chunk);
    } else if (frame.event === 'result-end') {
      result = asToolResult(
        await parseJsonChunksOffThread(resultChunks, options.signal),
        response.status,
      );
    } else if (frame.event === 'result') {
      result = asToolResult(JSON.parse(frame.data), response.status);
    } else if (frame.event === 'error') {
      const failure = JSON.parse(frame.data) as StreamingToolResult;
      result = {
        ...failure,
        success: false,
        httpStatus: failure.statusCode ?? response.status,
      };
    } else if (frame.event === 'done') {
      break;
    }
  }
  if (!result) throw new Error('Tool stream ended without a result');
  return result;
}
