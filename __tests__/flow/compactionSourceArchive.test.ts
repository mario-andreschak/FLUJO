import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { compactHistory, COMPACTION_SUMMARY_SECTIONS } from '@/backend/execution/flow/handlers/summarizingCompaction';
import {
  writeRunResource, listRunResources, readRunResourceBounded,
  _setRunResourcesDirForTests, _clearRunResourceSettingsCache,
} from '@/backend/services/runResources';
import { loadItem } from '@/utils/storage/backend';
import { DEFAULT_RUN_RESOURCE_SETTINGS, type RunResourceEntry } from '@/shared/types/runResources';

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: jest.fn(async () => ({ ...DEFAULT_RUN_RESOURCE_SETTINGS })),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

let root: string;
let previousRoot: string;
const producer = { source: 'compaction-artifact' as const, artifactId: 'source-artifact' };
const options = { keepTokens: 20, conversationId: 'source-case',
  projection: { conversationId: 'source-case', view: 'node-projected' as const, handoffPolicy: 'strip-v1' as const, version: 1 as const },
  sourceDigest: 'source', projectionDigest: 'projection', policyVersion: 'summary-v1' };
const summary = async () => COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- None.').join('\n\n');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const filename = (entry: RunResourceEntry) => path.join(root, entry.conversationId, entry.id + '.dat');
function resource(value: Awaited<ReturnType<typeof writeRunResource>>): RunResourceEntry {
  if ('skipped' in value) throw new Error('Unexpected resource refusal');
  return value;
}
const write = (json: unknown, name = 'source') => writeRunResource({
  conversationId: options.conversationId, name, kind: 'text', mimeType: 'application/json', data: { json }, producedBy: producer,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-compaction-source-'));
  previousRoot = _setRunResourcesDirForTests(root);
  jest.mocked(loadItem).mockResolvedValue({ ...DEFAULT_RUN_RESOURCE_SETTINGS });
  _clearRunResourceSettingsCache();
});

afterEach(async () => {
  jest.restoreAllMocks();
  _setRunResourcesDirForTests(previousRoot);
  _clearRunResourceSettingsCache();
  await fs.rm(root, { recursive: true, force: true });
});

it.each([
  null, true, -0, NaN, Infinity, '', '🧭\ud800\udc00\ud800x\udc00保留"\\\n',
  { omitted: undefined, nil: null, callback: () => undefined, symbol: Symbol('omit'), list: [undefined, null, NaN, -0] },
  { '10': 'ten', '2': 'two', nested: [{ ['a'.repeat(8191) + '🧭\ud800']: 'b'.repeat(8191) + '🧭\ud800\n' }] },
  { sparse: Array(3), bytes: new Uint8Array([3, 2]), date: new Date(0) },
  JSON.parse('{"__proto__":{"safe":true},"constructor":"data","é":1,"中":3}'),
])('persists the complete native JSON bytes, order and digest for %p', async json => {
  const expected = JSON.stringify(json);
  const entry = resource(await write(json));
  expect(entry).toMatchObject({ size: Buffer.byteLength(expected), sha256: sha256(expected), encoding: 'utf8', producedBy: producer });
  expect(await fs.readFile(filename(entry), 'utf8')).toBe(expected);
  expect((await listRunResources(options.conversationId))[0]).toMatchObject({ id: entry.id, sha256: entry.sha256 });
});

it('executes getters and custom toJSON once, with native keys, before publication', async () => {
  let getters = 0;
  let serializers = 0;
  const json = { unchanged: 'x'.repeat(100_000), nested: {
    get value() { getters++; return 'exact'; },
    custom: { toJSON(key: string) { serializers++; return { key, exact: 'pedido-ñ-002' }; } },
  } };
  const expected = JSON.stringify(json);
  getters = serializers = 0;
  const entry = resource(await write(json));
  expect(getters).toBe(1);
  expect(serializers).toBe(1);
  expect(await fs.readFile(filename(entry), 'utf8')).toBe(expected);
});

it('matches native serialization for 4096 mixed nested records without changing shared data', async () => {
  const atoms = ['🧭', '\ud800', '\udc00', '保留', '\n"\\', undefined, null, true, NaN, Infinity, -0,
    Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('')];
  const shared = Object.freeze({ exact: 'pedido-ñ-002', receipt: 'flujo://run/exact/source' });
  const json = Object.freeze(Array.from({ length: 4096 }, (_, index) => Object.freeze({
    '10': atoms[index % atoms.length], '2': atoms[(index + 3) % atoms.length],
    ['key-' + index + atoms[index % atoms.length]]: Object.freeze([atoms[(index + 7) % atoms.length], shared]),
    shared, omitted: undefined,
  })));
  const expected = JSON.stringify(json);
  const entry = resource(await write(json));
  expect(await fs.readFile(filename(entry), 'utf8')).toBe(expected);
  expect(entry.sha256).toBe(sha256(expected));
  expect(JSON.stringify(json)).toBe(expected);
});

it('preserves inherited array values and callable JSON compatibility', async () => {
  const list = Array(2);
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, '0', { get: () => 'inherited' });
  Object.setPrototypeOf(list, prototype);
  const callable = Object.assign(() => undefined, { toJSON: (key: string) => ({ key, exact: true }) });
  const json = { list, callable };
  const entry = resource(await write(json));
  expect(await fs.readFile(filename(entry), 'utf8')).toBe(JSON.stringify(json));
});

it.each(['circular', 'bigint'] as const)('retains the prior named resource and allows retry after invalid %s', async kind => {
  const prior = resource(await write({ previous: 'complete' }));
  const circular: Record<string, unknown> = { content: 'partial' };
  circular.self = circular;
  await expect(write(kind === 'circular' ? circular : { invalid: BigInt(1) })).rejects.toThrow();
  expect((await listRunResources(options.conversationId)).map(entry => entry.id)).toEqual([prior.id]);
  expect(await fs.readFile(filename(prior), 'utf8')).toBe('{"previous":"complete"}');
  const retried = resource(await write({ retried: 'complete' }));
  expect((await listRunResources(options.conversationId)).map(entry => entry.id)).toEqual([retried.id]);
});

function instrument(hooks: { beforeOpen?: () => void; failWrite?: boolean; shortWrites?: boolean; replacePath?: boolean } = {}) {
  const counts = { opened: 0, closed: 0, writtenBytes: 0, maxBuffer: 0, pending: 0, maxPending: 0 };
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (typeof args[0] !== 'string' || !args[0].endsWith('.dat')) return open(...args);
    hooks.beforeOpen?.();
    const handle = await open(...args);
    counts.opened++;
    const writeBuffer = handle.write.bind(handle);
    const writer = handle as unknown as {
      write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number; buffer: Buffer }>;
    };
    jest.spyOn(writer, 'write').mockImplementation(async (buffer, offset, length, position) => {
      counts.pending++;
      counts.maxPending = Math.max(counts.maxPending, counts.pending);
      try {
        counts.maxBuffer = Math.max(counts.maxBuffer, buffer.length);
        if (hooks.failWrite && counts.writtenBytes) throw new Error('Injected JSON write failure');
        await new Promise(resolve => setImmediate(resolve));
        const result = await writeBuffer(buffer, offset, hooks.shortWrites ? Math.min(3, length) : length, position);
        counts.writtenBytes += result.bytesWritten;
        return result;
      } finally { counts.pending--; }
    });
    const close = handle.close.bind(handle);
    jest.spyOn(handle, 'close').mockImplementation(async () => {
      counts.closed++;
      await close();
      if (hooks.replacePath) {
        await fs.rename(args[0] as string, path.join(root, 'original.dat'));
        await fs.writeFile(args[0] as string, 'foreign replacement');
      }
    });
    return handle;
  });
  return counts;
}

it('persists a large tool source with bounded writes and verified targeted tail recovery', async () => {
  const content = 'x'.repeat(4 * 1024 * 1024) + '\n🧭 pedido-ñ-002: NO enviar correo.';
  const call = { id: 'call-message', role: 'assistant', content: '', timestamp: 1,
    tool_calls: [{ id: 'send-once', type: 'function', function: { name: 'send', arguments: '{"exact":"ñ"}' } }] } as FlujoChatMessage;
  const tool = Object.freeze({ id: 'receipt', role: 'tool', tool_call_id: 'send-once', content, timestamp: 1 }) as FlujoChatMessage;
  const source = [call, tool];
  const expected = JSON.stringify(source);
  const counts = instrument();
  let stored: RunResourceEntry | undefined;
  const result = await compactHistory([...source, { id: 'recent', role: 'user', timestamp: 1, content: 'Continue. '.repeat(100) }], options, {
    summarize: summary,
    writeAnchor: async (messages, metadata) => {
      expect(messages).toEqual(source);
      stored = resource(await writeRunResource({ conversationId: options.conversationId, kind: 'text',
        mimeType: 'application/json', data: { json: messages }, producedBy: { ...producer, ...metadata } }));
      return stored.uri;
    },
  });
  expect(result?.artifact.summaryResourceUri).toBe(stored!.uri);
  expect(result?.artifact.summaryText).toContain('send-once');
  expect(stored!.sha256).toBe(sha256(expected));
  expect(counts).toMatchObject({ opened: 1, closed: 1, writtenBytes: Buffer.byteLength(expected), maxPending: 1 });
  expect(counts.maxBuffer).toBeLessThanOrEqual(64 * 1024);
  expect(await fs.readFile(filename(stored!), 'utf8')).toBe(expected);
  const startChar = expected.indexOf('pedido-ñ-002');
  const recovered = await readRunResourceBounded(stored!.uri, { startChar, maxChars: 200,
    expectedSha256: stored!.sha256, access: { at: 1, source: 'node', nodeId: 'recover' } });
  expect(recovered?.content).toContain('pedido-ñ-002: NO enviar correo.');
  expect(recovered?.verification?.ok).toBe(true);
  expect(tool.content).toBe(content);
});

it.each(['resource', 'conversation'] as const)('refuses the %s quota before opening a JSON payload', async scope => {
  jest.mocked(loadItem).mockResolvedValue({ ...DEFAULT_RUN_RESOURCE_SETTINGS,
    maxResourceBytes: scope === 'resource' ? 100 : 1000,
    maxConversationBytes: scope === 'conversation' ? 100 : 1000 });
  _clearRunResourceSettingsCache();
  const counts = instrument();
  expect(await write({ complete: '保留'.repeat(100) })).toEqual({ skipped: scope === 'resource' ? 'size-cap' : 'conversation-cap' });
  expect(counts.opened).toBe(0);
  expect(await listRunResources(options.conversationId)).toEqual([]);
});

it('preserves short writes without queuing buffers or changing JSON bytes', async () => {
  const counts = instrument({ shortWrites: true });
  const json = { exact: 'é🧭保留"\\\n'.repeat(30) };
  const entry = resource(await write(json));
  expect(await fs.readFile(filename(entry), 'utf8')).toBe(JSON.stringify(json));
  expect(counts).toMatchObject({ opened: 1, closed: 1, maxPending: 1, writtenBytes: entry.size });
});

it.each(['same-size', 'larger', 'invalid'] as const)('rejects %s edits after measurement and removes only its partial file', async edit => {
  const json: { content: unknown } = { content: 'before' };
  const counts = instrument({ beforeOpen: () => {
    json.content = edit === 'same-size' ? 'after!' : edit === 'larger' ? 'larger'.repeat(50_000) : BigInt(1);
  } });
  await expect(write(json)).rejects.toThrow('source changed');
  expect(counts).toMatchObject({ opened: 1, closed: 1 });
  expect(await listRunResources(options.conversationId)).toEqual([]);
  expect(await fs.readdir(path.join(root, options.conversationId))).toEqual([]);
});

it('retains canonical history and a prior anchor after disk failure, then retries successfully', async () => {
  const prior = resource(await write({ prior: 'complete' }));
  const source = [{ id: 'old', role: 'assistant', timestamp: 1, content: 'x'.repeat(200_000) },
    { id: 'new', role: 'user', timestamp: 1, content: 'Continue. '.repeat(100) }] as FlujoChatMessage[];
  const before = JSON.stringify(source);
  const counts = instrument({ failWrite: true });
  const deps = { summarize: summary, writeAnchor: async (messages: readonly FlujoChatMessage[]) => resource(await write(messages)).uri };
  expect(await compactHistory(source, options, deps)).toBeNull();
  expect(JSON.stringify(source)).toBe(before);
  expect(counts).toMatchObject({ opened: 1, closed: 1 });
  expect((await listRunResources(options.conversationId)).map(entry => entry.id)).toEqual([prior.id]);
  expect((await fs.readdir(path.join(root, options.conversationId))).filter(name => name.endsWith('.dat'))).toEqual([prior.id + '.dat']);
  jest.restoreAllMocks();
  const retried = await compactHistory(source, options, deps);
  expect(retried?.artifact.summaryResourceUri).toBeDefined();
  expect(JSON.stringify(source)).toBe(before);
});

it('preserves a replacement pathname and rejects its publication', async () => {
  const counts = instrument({ replacePath: true });
  await expect(write({ exact: 'source' })).rejects.toThrow('destination changed');
  expect(counts).toMatchObject({ opened: 1, closed: 1 });
  expect(await listRunResources(options.conversationId)).toEqual([]);
  const files = await fs.readdir(path.join(root, options.conversationId));
  expect(files).toHaveLength(1);
  expect(await fs.readFile(path.join(root, options.conversationId, files[0]), 'utf8')).toBe('foreign replacement');
});

it('keeps repeated exact-source persistence inside its capped-process allocation envelope', async () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=192', '--max-semi-space-size=1',
    path.resolve('__tests__/flow/fixtures/compactionSourceAllocation.cjs'), root, path.join(root, 'measurement.json')],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
  expect({ error: result.error?.message, status: result.status, stderr: result.status ? result.stderr : '',
    measurement: result.status ? result.stdout : '' })
    .toEqual({ error: undefined, status: 0, stderr: '', measurement: '' });
  expect(JSON.parse(await fs.readFile(path.join(root, 'measurement.json'), 'utf8')))
    .toMatchObject({ complete: true, withinEnvelope: true, samples: [expect.any(Object), expect.any(Object), expect.any(Object)] });
}, 35_000);
