const getModelMock = jest.fn();
const resolveKeyMock = jest.fn();
const createCompletionMock = jest.fn();
const searchRegistryMock = jest.fn();
const resolveRegistryEntryMock = jest.fn();
const installRegistryServerMock = jest.fn();
const probeOAuthSupportMock = jest.fn();

jest.mock('@/backend/services/model', () => ({
  modelService: { getModel: (...args: unknown[]) => getModelMock(...args), resolveAndDecryptApiKey: (...args: unknown[]) => resolveKeyMock(...args) },
}));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: (...args: unknown[]) => createCompletionMock(...args) }),
}));
jest.mock('@/backend/services/mcp/registryInstall', () => ({
  searchRegistry: (...args: unknown[]) => searchRegistryMock(...args),
  resolveRegistryEntry: (...args: unknown[]) => resolveRegistryEntryMock(...args),
  installRegistryServer: (...args: unknown[]) => installRegistryServerMock(...args),
}));
jest.mock('@/utils/mcp/oauthProbe', () => ({ probeOAuthSupport: (...args: unknown[]) => probeOAuthSupportMock(...args) }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));

import { readUtf8TextPrefix } from '@/utils/http/readUtf8TextPrefix';
import { researchMcpServers } from '@/backend/services/mcp/assistedInstall';
import type { RegistryServer } from '@/utils/mcp/registry';

const encode = (text: string) => new TextEncoder().encode(text);
const concat = (chunks: Uint8Array[]) => {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
};

// Zero high-water mark prevents automatic prefetch from obscuring explicit reads.
function bodyFixture(chunks: Uint8Array[], headers?: HeadersInit) {
  let index = 0;
  const pull = jest.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index === chunks.length) controller.close();
    else controller.enqueue(chunks[index++]);
  });
  const cancel = jest.fn();
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const response = new Response(stream, { headers });
  const text = jest.spyOn(response, 'text').mockImplementation(() => { throw new Error('Whole-body text must not run'); });
  return { response, stream, pull, cancel, text };
}

// An incorrect implementation must fail without waiting for wall-clock time.
async function promptly<T>(promise: Promise<T>): Promise<T> {
  const watchdog = async () => {
    for (let i = 0; i < 32; i++) await Promise.resolve();
    throw new Error('The completed prefix waited for the unused tail');
  };
  return Promise.race([promise, watchdog()]);
}

afterEach(() => { jest.restoreAllMocks(); });

describe('streamed Response.text UTF-8 prefix', () => {
  it.each([
    ['empty', '', 20],
    ['ASCII', 'calendar\n[Alpha](https://example.test)', 20],
    ['Unicode', 'café 中文 😀 calendar', 50],
    ['initial BOM', '\uFEFFcalendar', 50],
    ['surrogate boundary', 'A😀B', 2],
    ['CRLF', 'calendar\r\nsecond line', 50],
  ])('matches old text-and-slice output for %s', async (_name, value, limit) => {
    const bytes = encode(value as string);
    const expected = (await new Response(bytes).text()).slice(0, limit as number);
    const fixture = bodyFixture([bytes]);
    expect(await readUtf8TextPrefix(fixture.response, limit as number)).toBe(expected);
    expect(fixture.text).not.toHaveBeenCalled();
    expect(fixture.stream.locked).toBe(false);
  });

  it.each([
    { name: 'three-byte code point', chunks: [[0xe2], [0x82], [0xac]], limit: 10 },
    { name: 'four-byte point split at UTF16 limit', chunks: [[0xf0], [0x9f, 0x98], [0x80]], limit: 1 },
    { name: 'split initial BOM', chunks: [[0xef], [0xbb], [0xbf, 0x41]], limit: 10 },
    { name: 'invalid UTF8', chunks: [[0xe2], [0x28, 0xa1]], limit: 10 },
    { name: 'incomplete final UTF8', chunks: [[0xe2], [0x82]], limit: 10 },
    { name: 'BOM alone', chunks: [[0xef], [0xbb, 0xbf]], limit: 10 },
    { name: 'empty chunks', chunks: [[], [0x41], [], [0x42]], limit: 10 },
    { name: 'second BOM preserved', chunks: [[0xef, 0xbb, 0xbf], [0xef], [0xbb, 0xbf, 0x41]], limit: 10 },
  ])('preserves decoding across chunks: $name', async ({ name, chunks, limit }) => {
    const bytes = chunks.map(chunk => Uint8Array.from(chunk));
    const expected = (await new Response(concat(bytes)).text()).slice(0, limit);
    const fixture = bodyFixture(bytes);
    expect(await readUtf8TextPrefix(fixture.response, limit)).toBe(expected);
    expect(fixture.stream.locked).toBe(false);
    expect(fixture.text).not.toHaveBeenCalled();
    if (name === 'second BOM preserved') {
      // Retain this original case identity and its original failing input.
      // Additional reference vectors prevent stripping every leading or
      // interior BOM while matching Node Response.text()'s two-BOM behavior.
      const additionalChunks = [
        [Uint8Array.from([0xef]), Uint8Array.from([0xbb, 0xbf]), Uint8Array.from([0xef, 0xbb, 0xbf]), Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])],
        [encode('A'), Uint8Array.from([0xef]), Uint8Array.from([0xbb, 0xbf, 0x42])],
        [Uint8Array.from([0xef, 0xbb, 0xbf, 0xff]), Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])],
      ];
      for (const segments of additionalChunks) {
        const reference = (await new Response(concat(segments)).text()).slice(0, limit);
        const guarded = bodyFixture(segments);
        expect(await readUtf8TextPrefix(guarded.response, limit)).toBe(reference);
        expect(guarded.stream.locked).toBe(false);
        expect(guarded.text).not.toHaveBeenCalled();
      }
    }
  });

  it('stops at an exact limit without a read to discover tail EOF', async () => {
    const fixture = bodyFixture([encode('abcd')]);
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    expect(await readUtf8TextPrefix(fixture.response, 4)).toBe('abcd');
    expect(fixture.pull).toHaveBeenCalledTimes(1);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(fixture.stream.locked).toBe(false);
  });

  it('returns a finite oversized prefix without requesting the remaining chunk', async () => {
    const fixture = bodyFixture([encode('abc'), encode('defghi'), encode('unread')]);
    expect(await readUtf8TextPrefix(fixture.response, 5)).toBe('abcde');
    expect(fixture.pull).toHaveBeenCalledTimes(2);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.text).not.toHaveBeenCalled();
  });

  it('stops an otherwise endless source before its read guard fires', async () => {
    const cancel = jest.fn();
    let requestedChunks = 0;
    const pull = jest.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (++requestedChunks > 3) throw new Error('Read beyond the admitted prefix');
      controller.enqueue(encode('abcd'));
    });
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    expect(await promptly(readUtf8TextPrefix(new Response(stream), 10))).toBe('abcdabcdab');
    expect(pull).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it('decodes an oversized received chunk only in bounded pieces and stops within it', async () => {
    const fixture = bodyFixture([encode('x'.repeat(1_000_000)), encode('unread')]);
    const decode = jest.spyOn(TextDecoder.prototype, 'decode');
    expect(await readUtf8TextPrefix(fixture.response, 70_000)).toBe('x'.repeat(70_000));
    expect(decode).toHaveBeenCalledTimes(2);
    for (const [input, options] of decode.mock.calls) {
      expect(input?.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(options).toEqual({ stream: true });
    }
    expect(fixture.pull).toHaveBeenCalledTimes(1);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.text).not.toHaveBeenCalled();
  });

  it('carries a UTF8 code point across the internal 64KiB decoding boundary', async () => {
    const value = `${'x'.repeat(65_535)}😀tail`;
    const expected = (await new Response(encode(value)).text()).slice(0, 65_537);
    const fixture = bodyFixture([encode(value)]);
    const decode = jest.spyOn(TextDecoder.prototype, 'decode');
    expect(await readUtf8TextPrefix(fixture.response, 65_537)).toBe(expected);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
  });

  it('releases once at short-body EOF without cancellation', async () => {
    const fixture = bodyFixture([encode('short')]);
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    expect(await readUtf8TextPrefix(fixture.response, 100)).toBe('short');
    expect(fixture.pull).toHaveBeenCalledTimes(2);
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(fixture.stream.locked).toBe(false);
  });

  it('returns empty text for a null body without acquiring a reader', async () => {
    const response = new Response(null);
    const read = jest.spyOn(ReadableStreamDefaultReader.prototype, 'read');
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    const text = jest.spyOn(response, 'text');
    expect(await readUtf8TextPrefix(response, 100)).toBe('');
    expect(read).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it('cancels and releases a zero-budget body without reading', async () => {
    const fixture = bodyFixture([encode('unread')]);
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    expect(await readUtf8TextPrefix(fixture.response, 0)).toBe('');
    expect(fixture.pull).not.toHaveBeenCalled();
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid budget %s before reader ownership', async limit => {
    const fixture = bodyFixture([encode('unread')]);
    expect(await readUtf8TextPrefix(fixture.response, limit).catch(error => error)).toBeInstanceOf(RangeError);
    expect(fixture.pull).not.toHaveBeenCalled();
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(fixture.stream.locked).toBe(false);
  });

  it('propagates the original read failure after one cancel and release', async () => {
    const failure = new Error('synthetic read failure');
    const stream = new ReadableStream<Uint8Array>({ pull: () => { throw failure; } }, { highWaterMark: 0 });
    const cancel = jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    await expect(readUtf8TextPrefix(new Response(stream), 100)).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it('releases an aborted pending stream read and preserves the abort reason', async () => {
    const abort = new AbortController();
    const failure = new DOMException('synthetic abort', 'AbortError');
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      abort.signal.addEventListener('abort', () => controller.error(abort.signal.reason), { once: true });
    } }, { highWaterMark: 0 });
    const cancel = jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    const result = readUtf8TextPrefix(new Response(stream), 100);
    abort.abort(failure);
    await expect(result).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it('handles tail cancellation rejection without discarding a full prefix', async () => {
    const fixture = bodyFixture([encode('prefix'), encode('unread')]);
    fixture.cancel.mockRejectedValueOnce(new Error('synthetic cancel failure'));
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    expect(await promptly(readUtf8TextPrefix(fixture.response, 6))).toBe('prefix');
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(fixture.stream.locked).toBe(false);
    await Promise.resolve(); // Let the attached rejection handler settle.
  });

  it('does not wait for a never-settling tail cancellation to release a full prefix', async () => {
    const fixture = bodyFixture([encode('prefix'), encode('unread')]);
    fixture.cancel.mockImplementationOnce(() => new Promise<void>(() => {}));
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    expect(await promptly(readUtf8TextPrefix(fixture.response, 6))).toBe('prefix');
    expect(fixture.pull).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(fixture.stream.locked).toBe(false);
  });

  it('releases once even if the owned reader cancellation throws synchronously', async () => {
    const fixture = bodyFixture([encode('prefix')]);
    jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel').mockImplementationOnce(() => { throw new Error('synthetic synchronous cancel'); });
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    expect(await readUtf8TextPrefix(fixture.response, 6)).toBe('prefix');
    expect(release).toHaveBeenCalledTimes(1);
    expect(fixture.stream.locked).toBe(false);
  });

  it.each([undefined, '0', '1', '99999999'])('enforces its limit independently of Content-Length=%s', async length => {
    const fixture = bodyFixture([encode('123456789'), encode('unread')], length === undefined ? {} : { 'Content-Length': length });
    expect(await readUtf8TextPrefix(fixture.response, 4)).toBe('1234');
    expect(fixture.pull).toHaveBeenCalledTimes(1);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a text-only Response substitute without an unbounded fallback', async () => {
    const text = jest.fn().mockResolvedValue('whole body');
    const incomplete = { ok: true, text } as unknown as Response;
    await expect(readUtf8TextPrefix(incomplete, 4)).rejects.toBeInstanceOf(TypeError);
    expect(text).not.toHaveBeenCalled();
  });
});

const RAW_LISTS = [
  'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md',
  'https://raw.githubusercontent.com/appcypher/awesome-mcp-servers/main/README.md',
];
const ALPHA_LINE = 'calendar [Alpha Bridge](https://example.test/alpha) <b>calendar connector</b>';
const BETA_LINE = 'calendar [Beta Bridge](https://example.test/beta) calendar connector';
const makeServer = (slug: string): RegistryServer => ({
  name: `io.example/${slug}`, title: slug === 'alpha' ? 'Alpha' : 'Beta', description: 'calendar connector',
  version: '1.0.0', packages: [{ registryType: 'npm', identifier: `@example/${slug}`, version: '1.0.0', transport: { type: 'stdio' } }],
});

describe('offline actual MCP research body admission', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    getModelMock.mockResolvedValue({ ApiKey: 'offline-reference', adapter: 'openai', maxTokens: 2048 });
    resolveKeyMock.mockResolvedValue('offline-test-credential');
    createCompletionMock.mockImplementation(async ({ messages }: { messages: Array<{ role: string; content: string }> }) => ({
      completion: { choices: [{ message: { content: JSON.stringify(messages[0].content.startsWith('Turn a user request')
        ? { service: 'calendar', suggestedName: 'calendar', searches: ['calendar'] }
        : { summary: 'Offline evidence summary', notes: {} }) } }] },
    }));
    searchRegistryMock.mockResolvedValue(['beta', 'alpha'].map(slug => ({
      name: `io.example/${slug}`, installable: true, requiredEnv: [], quality: { score: 0.7, status: 'active', stars: 10, weeklyDownloads: 0 },
    })));
    resolveRegistryEntryMock.mockImplementation(async (name: string) => ({ server: makeServer(name.endsWith('alpha') ? 'alpha' : 'beta') }));
    installRegistryServerMock.mockImplementation(() => { throw new Error('Research must not install'); });
    probeOAuthSupportMock.mockImplementation(() => { throw new Error('Package fixtures must not probe OAuth'); });
  });

  function mockDiscovery(readmes: Array<Response | Error>) {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const index = RAW_LISTS.indexOf(url);
      if (index >= 0) {
        const response = readmes[index];
        if (response instanceof Error) throw response;
        if (!response) throw new Error('Missing offline README response');
        return response;
      }
      if (url.startsWith('https://api.github.com/search/repositories?')) return new Response('{"items":[]}');
      if (url.startsWith('https://registry.npmjs.org/-/v1/search?')) return new Response('{"objects":[]}');
      throw new Error(`Unmocked external request: ${url}`);
    });
    return { fetch, timeout };
  }

  const research = () => researchMcpServers({ query: 'calendar', modelId: 'offline-model' });
  const explanationEvidence = () => JSON.parse(createCompletionMock.mock.calls[1][0].messages[1].content);
  const expectNoSideEffects = () => {
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(probeOAuthSupportMock).not.toHaveBeenCalled();
    expect(createCompletionMock).toHaveBeenCalledTimes(2);
    expect(getModelMock).toHaveBeenCalledWith('offline-model');
  };

  it('preserves short-body snippets, deterministic ranking, URLs, timeout and source metadata', async () => {
    const first = bodyFixture([encode(ALPHA_LINE)]);
    const second = bodyFixture([encode('unrelated list')]);
    const controls = mockDiscovery([first.response, second.response]);
    const result = await research();
    expect(explanationEvidence().web.awesome).toEqual([{ label: 'Alpha Bridge', url: 'https://example.test/alpha', line: 'calendar [Alpha Bridge](https://example.test/alpha) calendar connector' }]);
    expect(result.candidates.map(candidate => [candidate.registryName, candidate.score, candidate.recommended])).toEqual([
      ['io.example/alpha', 0.755, true], ['io.example/beta', 0.695, false],
    ]);
    expect(result.candidates[0].reasons).toContain('Also listed by an Awesome MCP community index');
    expect(result.sources.find(source => source.id === 'awesome-mcp')).toEqual({
      id: 'awesome-mcp', label: 'Awesome MCP Servers', url: 'https://github.com/punkpeye/awesome-mcp-servers', status: 'searched', detail: '1 relevant result inspected',
    });
    const rawCalls = controls.fetch.mock.calls.filter(([url]) => RAW_LISTS.includes(String(url)));
    expect(rawCalls.map(([url]) => url)).toEqual(RAW_LISTS);
    for (const [, init] of rawCalls) expect(init).toEqual({ signal: expect.any(AbortSignal) });
    expect(controls.timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([12_000, 12_000, 12_000, 12_000]);
    expect(first.text).not.toHaveBeenCalled();
    expect(second.text).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('keeps nested tags and unmatched delimiters out of discovery snippets', async () => {
    const hostile = `${ALPHA_LINE} <scr<script>ipt>alert(1)</scr</script>ipt> <SCRIPT>upper</SCRIPT> <unfinished`;
    mockDiscovery([bodyFixture([encode(hostile)]).response, bodyFixture([encode('unrelated list')]).response]);
    await research();
    const [snippet] = explanationEvidence().web.awesome;
    expect(snippet.label).toBe('Alpha Bridge');
    expect(snippet.url).toBe('https://example.test/alpha');
    expect(snippet.line).not.toMatch(/[<>]/);
    expect(snippet.line).toContain('calendar connector');
    expectNoSideEffects();
  });

  it('excludes post-budget evidence and ignores an indefinitely pending unused-tail cancellation', async () => {
    const prefix = `${ALPHA_LINE}\n`.padEnd(2_000_000, ' ');
    const first = bodyFixture([encode(`${prefix}\n${BETA_LINE}`), encode('unread')]);
    first.cancel.mockImplementationOnce(() => new Promise<void>(() => {}));
    mockDiscovery([first.response, new Response('unrelated')]);
    const result = await research();
    expect(explanationEvidence().web.awesome.map((entry: { label: string }) => entry.label)).toEqual(['Alpha Bridge']);
    expect(result.candidates.map(candidate => candidate.score)).toEqual([0.755, 0.695]);
    expect(first.pull).toHaveBeenCalledTimes(1);
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(first.stream.locked).toBe(false);
    expect(first.text).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('keeps the surviving list useful when the other fetch fails', async () => {
    mockDiscovery([new Error('offline failed list'), new Response(BETA_LINE)]);
    const result = await research();
    expect(explanationEvidence().web.awesome.map((entry: { label: string }) => entry.label)).toEqual(['Beta Bridge']);
    expect(result.candidates[0].registryName).toBe('io.example/beta');
    expect(result.sources.find(source => source.id === 'awesome-mcp')?.detail).toBe('1 relevant result inspected');
    expectNoSideEffects();
  });

  it('keeps surviving results when the other response body errors', async () => {
    const failed = new ReadableStream<Uint8Array>({ pull: () => { throw new Error('offline body failure'); } }, { highWaterMark: 0 });
    mockDiscovery([new Response(failed), new Response(BETA_LINE)]);
    const result = await research();
    expect(result.candidates[0].registryName).toBe('io.example/beta');
    expect(explanationEvidence().web.awesome).toHaveLength(1);
    expect(failed.locked).toBe(false);
    expectNoSideEffects();
  });

  it('retains per-list, merged, model-evidence and snippet limits', async () => {
    const lines = Array.from({ length: 12 }, (_, index) => `calendar [Alpha ${index} ${'z'.repeat(130)}](https://example.test/${index}) ${'x'.repeat(600)}`).join('\n');
    mockDiscovery([new Response(lines), new Response(lines)]);
    const result = await research();
    const awesome = explanationEvidence().web.awesome as Array<{ label: string; line: string }>;
    expect(result.sources.find(source => source.id === 'awesome-mcp')?.detail).toBe('15 relevant results inspected');
    expect(awesome).toHaveLength(5);
    for (const entry of awesome) { expect(entry.label).toHaveLength(120); expect(entry.line).toHaveLength(500); }
    expectNoSideEffects();
  });

  it('does not use a text-only mock fallback when one list lacks a stream body', async () => {
    const text = jest.fn().mockResolvedValue(ALPHA_LINE);
    mockDiscovery([{ ok: true, text } as unknown as Response, new Response(BETA_LINE)]);
    const result = await research();
    expect(text).not.toHaveBeenCalled();
    expect(result.candidates[0].registryName).toBe('io.example/beta');
    expectNoSideEffects();
  });
});
