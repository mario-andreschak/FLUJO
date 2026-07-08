/**
 * Regression test for the streaming Install/Build frontend consumer (issue #65).
 *
 * When an `onOutput` callback is supplied, installDependencies/buildServer must hit the
 * streaming git action, forward each stdout/stderr chunk to `onOutput` as it arrives, and
 * resolve with the final result. When the stream is unavailable (no readable body), they
 * must gracefully fall back to the non-streaming request.
 */

import { encodeNdjsonLine } from '@/shared/utils/ndjson';
import { installDependencies, buildServer } from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/buildUtils';

/** A Response-like object whose body streams the given NDJSON events. */
function streamingResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const chunks = events.map((e) => encoder.encode(encodeNdjsonLine(e)));
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true },
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response;
}

/** A Response-like object with no streamable body (forces the non-streaming fallback). */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    body: null,
    json: async () => body,
  } as unknown as Response;
}

describe('buildUtils streaming (#65)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('installDependencies forwards streamed chunks and returns success', async () => {
    const fetchMock = jest.fn(async () =>
      streamingResponse([
        { type: 'status', phase: 'running', message: 'Executing: npm install\n' },
        { type: 'stdout', data: 'added 10 packages\n' },
        { type: 'stderr', data: 'npm warn deprecated\n' },
        { type: 'result', success: true, commandOutput: 'added 10 packages\nnpm warn deprecated\n' },
      ])
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const chunks: string[] = [];
    const result = await installDependencies('mcp-servers/srv', 'npm install', (c) => chunks.push(c));

    expect(chunks).toEqual(['added 10 packages\n', 'npm warn deprecated\n']);
    expect(result.success).toBe(true);
    expect(result.output).toContain('added 10 packages');

    // It used the streaming action.
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.action).toBe('installStream');
  });

  it('buildServer reports failure from the terminal result event', async () => {
    global.fetch = jest.fn(async () =>
      streamingResponse([
        { type: 'stdout', data: 'compiling...\n' },
        { type: 'result', success: false, error: 'exit code 1', commandOutput: 'compiling...\nerror TS1\n' },
      ])
    ) as unknown as typeof fetch;

    const chunks: string[] = [];
    const result = await buildServer('mcp-servers/srv', 'npm run build', (c) => chunks.push(c));

    expect(chunks).toEqual(['compiling...\n']);
    expect(result.success).toBe(false);
    expect(result.message.type).toBe('error');
  });

  it('falls back to the non-streaming request when the body cannot be streamed', async () => {
    // First call = streaming attempt (no body) -> null; second call = non-streaming JSON.
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ success: true, commandOutput: 'done via fallback' }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const chunks: string[] = [];
    const result = await installDependencies('mcp-servers/srv', 'npm install', (c) => chunks.push(c));

    expect(chunks).toEqual([]); // nothing streamed
    expect(result.success).toBe(true);
    expect(result.output).toBe('done via fallback');

    // Two fetches: streaming action then non-streaming action.
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(calls[0][1].body as string).action).toBe('installStream');
    expect(JSON.parse(calls[1][1].body as string).action).toBe('install');
  });
});
