/**
 * @jest-environment node
 *
 * Node env so fetch/TextDecoder/ReadableStream behave like the runtime. Covers
 * the NDJSON pull-progress parsing and the human-readable line formatting.
 */
import { pull, formatPullProgress, type OllamaPullProgress } from '@/backend/services/ollama';

const MB = 1024 * 1024;

/**
 * A minimal stand-in for `fetch`'s Response that exposes exactly what `pull`
 * consumes: `ok` and a `body.getReader()` yielding the given NDJSON chunks.
 */
function streamingResponse(chunks: string[]) {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < encoded.length ? { value: encoded[i++], done: false } : { value: undefined, done: true },
        releaseLock: () => {},
      }),
    },
  };
}

describe('formatPullProgress', () => {
  it('renders a percentage and MB when total/completed are present', () => {
    expect(
      formatPullProgress({ status: 'downloading', total: 100 * MB, completed: 45 * MB })
    ).toBe('downloading — 45% (45/100 MB)');
  });

  it('renders the status alone when there is no size info', () => {
    expect(formatPullProgress({ status: 'verifying sha256 digest' })).toBe('verifying sha256 digest');
  });

  it('falls back to "pulling" when status is missing', () => {
    expect(formatPullProgress({})).toBe('pulling');
  });
});

describe('ollama pull', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('invokes onProgress for each NDJSON line, even when split across chunks', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      streamingResponse([
        '{"status":"pulling manifest"}\n{"status":"downloa',
        'ding","total":100,"completed":50}\n',
        '{"status":"success"}\n',
      ])
    ) as unknown as typeof fetch;

    const got: OllamaPullProgress[] = [];
    await pull('llama3.2:3b', (p) => got.push(p));

    expect(got).toEqual([
      { status: 'pulling manifest' },
      { status: 'downloading', total: 100, completed: 50 },
      { status: 'success' },
    ]);
  });

  it('throws with the HTTP status when Ollama returns a non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }) as unknown as typeof fetch;

    await expect(pull('whatever', () => {})).rejects.toThrow(/HTTP 500/);
  });
});
