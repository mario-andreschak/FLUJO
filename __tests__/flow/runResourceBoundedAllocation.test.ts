import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  writeRunResource, readRunResourceBounded, listRunResources,
  _setRunResourcesDirForTests, _clearRunResourceSettingsCache,
} from '@/backend/services/runResources';
import { DEFAULT_RUN_RESOURCE_SETTINGS, type RunResourceEntry } from '@/shared/types/runResources';

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: jest.fn(async () => ({ ...DEFAULT_RUN_RESOURCE_SETTINGS })),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug() {}, error() {}, warn() {} }) }));

let root: string;
let previousRoot: string;
let entry: RunResourceEntry;
let filename: string;
const access = { at: 123, source: 'node' as const, nodeId: 'node-1' };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-run-resource-bounded-'));
  previousRoot = _setRunResourcesDirForTests(root);
  _clearRunResourceSettingsCache();
  const result = await writeRunResource({
    conversationId: 'conversation-1', name: 'exact-source', kind: 'text', mimeType: 'text/plain',
    data: { text: 'head' }, producedBy: { source: 'capture' },
  });
  if ('skipped' in result) throw new Error('Fixture resource was refused');
  entry = result;
  filename = path.join(root, entry.conversationId, `${entry.id}.dat`);
});

afterEach(async () => {
  jest.restoreAllMocks();
  _setRunResourcesDirForTests(previousRoot);
  _clearRunResourceSettingsCache();
  await fs.rm(root, { recursive: true, force: true });
});

function instrumentPayload(hooks: { afterStat?: () => Promise<void>; beforeRead?: () => Promise<void>; shortReads?: boolean } = {}) {
  const counts = { opened: 0, closed: 0, readBytes: 0, maxBufferBytes: 0, readCalls: 0, wholeFilePayloadBytes: 0 };
  const readFile = fs.readFile.bind(fs);
  jest.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const result = await readFile(...args);
    if (args[0] === filename) counts.wholeFilePayloadBytes += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
    return result;
  });
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] !== filename) return handle;
    counts.opened++;
    const stat = handle.stat.bind(handle);
    jest.spyOn(handle, 'stat').mockImplementation(async () => {
      const result = await stat();
      await hooks.afterStat?.();
      return result;
    });
    const read = handle.read.bind(handle);
    jest.spyOn(handle, 'read').mockImplementation(async (...readArgs: unknown[]) => {
      const [buffer, offset, length, position] = readArgs as [Buffer, number, number, number];
      await hooks.beforeRead?.();
      counts.maxBufferBytes = Math.max(counts.maxBufferBytes, buffer.length);
      counts.readCalls++;
      const result = await read(buffer, offset, hooks.shortReads ? Math.min(1, length) : length, position);
      counts.readBytes += result.bytesRead;
      return result;
    });
    const close = handle.close.bind(handle);
    jest.spyOn(handle, 'close').mockImplementation(async () => { counts.closed++; await close(); });
    return handle;
  });
  return counts;
}

it('fetches a tiny prefix from a 32 MiB payload without reading or allocating the full file', async () => {
  await fs.truncate(filename, 32 * 1024 * 1024);
  const counts = instrumentPayload();
  const result = await readRunResourceBounded(entry.uri, { maxChars: 25, access });
  expect(result).toMatchObject({ content: 'head' + '\0'.repeat(21), truncated: true });
  expect(result?.verification).toBeUndefined();
  expect(counts.wholeFilePayloadBytes).toBe(0);
  expect(counts.readBytes).toBeLessThanOrEqual(64 * 1024);
  expect(counts.readBytes).toBeGreaterThan(0);
  expect(counts.maxBufferBytes).toBeLessThanOrEqual(64 * 1024);
  expect(counts.closed).toBe(counts.opened);
  expect((await listRunResources(entry.conversationId))[0].readBy).toEqual([access]);
});

it('streams the complete SHA-256 while retaining only the requested prefix', async () => {
  const size = 32 * 1024 * 1024;
  await fs.truncate(filename, size);
  // Independent expected digest: known sparse-file contents, one reusable chunk.
  const hasher = createHash('sha256').update('head');
  const zeros = Buffer.alloc(64 * 1024);
  for (let remaining = size - 4; remaining > 0; remaining -= zeros.length) {
    hasher.update(zeros.subarray(0, Math.min(remaining, zeros.length)));
  }
  const expectedSha256 = hasher.digest('hex');
  const counts = instrumentPayload();
  const result = await readRunResourceBounded(entry.uri, { maxChars: 25, expectedSha256, access });
  expect(result).toMatchObject({
    content: 'head' + '\0'.repeat(21), truncated: true,
    verification: { expectedSha256, actualSha256: expectedSha256, ok: true },
  });
  expect(counts.readBytes).toBe(size);
  expect(counts.maxBufferBytes).toBeLessThanOrEqual(64 * 1024);
  expect(counts.closed).toBe(counts.opened);
  expect((await listRunResources(entry.conversationId))[0].verifications).toEqual([
    expect.objectContaining({ expectedSha256, actualSha256: expectedSha256, ok: true }),
  ]);
});

it.each([65_535, 65_536, 65_537, 65_538, 65_539])(
  'preserves UTF-8 chunk boundaries and UTF-16 slicing at %i characters', async maxChars => {
    const bytes = Buffer.concat([Buffer.from('a'.repeat(65_535) + '😀é'), Buffer.from([0xff])]);
    await fs.writeFile(filename, bytes);
    const expectedText = bytes.toString('utf8');
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await readRunResourceBounded(entry.uri, { maxChars, expectedSha256, access });
    expect(result?.content).toBe(expectedText.slice(0, maxChars));
    expect(result?.truncated).toBe(expectedText.length > maxChars);
    expect(result?.verification?.ok).toBe(true);
  },
);

it('handles fragmented reads without corrupting a multi-byte character', async () => {
  await fs.writeFile(filename, '😀é終');
  const counts = instrumentPayload({ shortReads: true });
  const result = await readRunResourceBounded(entry.uri, { maxChars: 3, access });
  expect(result).toMatchObject({ content: '😀é', truncated: true });
  expect(counts.readBytes).toBe(9);
  expect(counts.closed).toBe(1);
});

it.each(['', 'abcd', 'abcde'])('reports truncation correctly for a short or empty payload', async text => {
  await fs.writeFile(filename, text);
  const counts = instrumentPayload();
  const result = await readRunResourceBounded(entry.uri, { maxChars: 4, access });
  expect(result).toMatchObject({ content: text.slice(0, 4), truncated: text.length > 4 });
  expect(counts.closed).toBe(1);
});

it.each([[NaN, 50_000], [Infinity, 200_000], [-Infinity, 1], [0, 1]])(
  'retains a finite prefix limit for %s', async (maxChars, expectedLength) => {
    await fs.writeFile(filename, 'x'.repeat(256 * 1024));
    const result = await readRunResourceBounded(entry.uri, { maxChars, access });
    expect(result?.content.length).toBe(expectedLength);
    expect(result?.truncated).toBe(true);
  },
);

it('verifies the checked descriptor after its pathname is replaced', async () => {
  const original = 'Original resource bytes';
  await fs.writeFile(filename, original);
  const expectedSha256 = createHash('sha256').update(original).digest('hex');
  let replaced = false;
  const counts = instrumentPayload({ afterStat: async () => {
    if (replaced) return;
    replaced = true;
    await fs.rename(filename, path.join(root, 'old.dat'));
    await fs.writeFile(filename, 'Unchecked replacement bytes');
  } });
  const result = await readRunResourceBounded(entry.uri, { maxChars: 200, expectedSha256, access });
  expect(result).toMatchObject({ content: original, verification: { ok: true, actualSha256: expectedSha256 } });
  expect(counts.closed).toBe(1);
});

it.each(['truncate', 'grow'] as const)('refuses a complete verification when the opened file changes (%s)', async change => {
  await fs.truncate(filename, 128 * 1024);
  let changed = false;
  const counts = instrumentPayload({ beforeRead: async () => {
    if (changed) return;
    changed = true;
    if (change === 'truncate') await fs.truncate(filename, 2);
    else await fs.appendFile(filename, 'changed');
  } });
  expect(await readRunResourceBounded(entry.uri, { maxChars: 3, expectedSha256: 'f'.repeat(64), access })).toBeNull();
  expect(counts.closed).toBe(1);
  expect((await listRunResources(entry.conversationId))[0].verifications ?? []).toEqual([]);
});

it('returns an actual mismatched full digest, never a digest of the prefix', async () => {
  const bytes = 'head' + 'tail'.repeat(50_000);
  await fs.writeFile(filename, bytes);
  const result = await readRunResourceBounded(entry.uri, { maxChars: 4, expectedSha256: 'f'.repeat(64), access });
  expect(result?.verification).toEqual({
    expectedSha256: 'f'.repeat(64), actualSha256: createHash('sha256').update(bytes).digest('hex'), ok: false,
  });
});

it('checks binary payload existence without materializing its bytes for a summary', async () => {
  const result = await writeRunResource({
    conversationId: 'conversation-1', name: 'binary', kind: 'image', mimeType: 'image/png',
    data: { base64: Buffer.from([1, 2, 3]).toString('base64') }, producedBy: { source: 'capture' },
  });
  if ('skipped' in result) throw new Error('Binary fixture was refused');
  entry = result;
  filename = path.join(root, entry.conversationId, `${entry.id}.dat`);
  await fs.truncate(filename, 8 * 1024 * 1024);
  const counts = instrumentPayload();
  const summary = await readRunResourceBounded(entry.uri, { maxChars: 1000, access });
  expect(summary?.content).toContain('[binary run resource image/png');
  expect(summary?.verification).toBeUndefined();
  expect(counts.readBytes).toBe(0);
  expect(counts.closed).toBe(1);
  await fs.unlink(filename);
  expect(await readRunResourceBounded(entry.uri, { access })).toBeNull();
});
