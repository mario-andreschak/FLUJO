/**
 * Tier 3 — run-scoped resource store.
 *
 * Pins the store's contract: write/read/list round-trips (text + binary),
 * named-overwrite semantics (`${res:NAME}` stability), URI build/parse, the
 * path-safety gate (ids become file names), size/conversation caps returning
 * `{ skipped }` instead of throwing (capture must never break a run), readBy
 * lineage appends, and idempotent per-conversation deletion.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import * as storage from '@/utils/storage/backend';
import {
  writeRunResource,
  listRunResources,
  listAllRunResources,
  readRunResource,
  readRunResourceRange,
  copyRunResourceToConversation,
  getRunResourceLocalPath,
  findRunResourceByName,
  deleteRunResources,
  sweepOldRunResources,
  buildRunResourceUri,
  parseRunResourceUri,
  _setRunResourcesDirForTests,
  _clearRunResourceSettingsCache,
} from '@/backend/services/runResources';
import { captureToolResult } from '@/backend/services/runResources/capture';
import {
  executeRunResourceTool,
  READ_RESOURCE_TOOL_NAME,
} from '@/backend/execution/flow/handlers/runResourceTools';
import { DEFAULT_RUN_RESOURCE_SETTINGS, type RunResourceEntry } from '@/shared/types/runResources';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Settings come from storage (loadItem). Pin them to defaults with a tight
// per-resource cap so the cap paths are testable without megabyte payloads.
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return {
    ...actual,
    writeFileAtomic: jest.fn((...args: unknown[]) => actual.writeFileAtomic(...args)),
    loadItem: jest.fn(async (_key: unknown, defaultValue: unknown) => ({
      ...(defaultValue as Record<string, unknown>),
      maxResourceBytes: 1024,
      maxConversationBytes: 2048,
    })),
  };
});

let tmpDir: string;
let previousDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-runres-'));
  previousDir = _setRunResourcesDirForTests(tmpDir);
});

afterAll(async () => {
  _setRunResourcesDirForTests(previousDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _clearRunResourceSettingsCache();
});

const producedBy = { source: 'capture' as const, nodeId: 'node-1' };

it('admits real text captures before UTF-8 Buffer.from for both quota refusals', async () => {
  const oversized = 'oversized-' + 'x'.repeat(1024);
  const from = jest.spyOn(Buffer, 'from');
  try {
    expect(await writeRunResource({ conversationId: 'encode-size', kind: 'text', data: { text: oversized }, producedBy })).toEqual({ skipped: 'size-cap' });
    expect(from.mock.calls.some(([value]) => value === oversized)).toBe(false);
    await writeRunResource({ conversationId: 'encode-conversation', kind: 'text', data: { text: 'a'.repeat(1024) }, producedBy });
    await writeRunResource({ conversationId: 'encode-conversation', kind: 'text', data: { text: 'b'.repeat(1024) }, producedBy });
    const refused = 'must not encode after conversation quota';
    expect(await writeRunResource({ conversationId: 'encode-conversation', kind: 'text', data: { text: refused }, producedBy })).toEqual({ skipped: 'conversation-cap' });
    expect(from.mock.calls.some(([value]) => value === refused)).toBe(false);
  } finally { from.mockRestore(); }
});

it('reuses capture receipts and immutable bytes while rejecting changed content or metadata', async () => {
  const input = { conversationId: 'capture-effects', kind: 'text' as const, name: 'answer', data: { text: 'first result' }, producedBy, idempotencyKey: 'visit-1:capture' };
  const first = await writeRunResource(input) as RunResourceEntry;
  const again = await writeRunResource(input) as RunResourceEntry;
  expect(again.uri).toBe(first.uri);
  await expect(writeRunResource({ ...input, data: { text: 'other result' } })).rejects.toMatchObject({ name: 'RunResourceIdempotencyError' });
  await expect(writeRunResource({ ...input, mimeType: 'text/plain' })).rejects.toMatchObject({ name: 'RunResourceIdempotencyError' });
  const later = await writeRunResource({ ...input, data: { text: 'later result' }, idempotencyKey: 'visit-2:capture' }) as RunResourceEntry;
  expect((await writeRunResource(input) as RunResourceEntry).uri).toBe(first.uri);
  expect((await findRunResourceByName(input.conversationId, 'answer'))?.uri).toBe(later.uri);
  expect((await readRunResource(first.uri))?.contents.contents[0]).toMatchObject({ text: 'first result' });
});

it('copies each source effect once across retries and conflicts on changed source bytes', async () => {
  const source = await writeRunResource({ conversationId: 'effect-child', kind: 'text', data: { text: 'owned source' }, producedBy }) as RunResourceEntry;
  const input = { uri: source.uri, conversationId: 'effect-parent', idempotencyKey: 'visit:source', producedBy };
  const first = await copyRunResourceToConversation(input) as RunResourceEntry;
  const again = await copyRunResourceToConversation(input) as RunResourceEntry;
  expect(again.uri).toBe(first.uri); expect(await listRunResources('effect-parent')).toHaveLength(1);
  await fs.writeFile(path.join(tmpDir, source.conversationId, `${source.id}.dat`), 'changed source');
  await expect(copyRunResourceToConversation(input)).rejects.toMatchObject({ name: 'RunResourceIdempotencyError' });
  expect(await listRunResources('effect-parent')).toHaveLength(1);
});

it.each(['before', 'after'] as const)('reconciles an idempotent copied payload after a %s-index-commit failure', async phase => {
  const child = await writeRunResource({ conversationId: `orphan-child-${phase}`, kind: 'text', data: { text: 'exact source' }, producedBy }) as RunResourceEntry;
  const input = { uri: child.uri, conversationId: `orphan-parent-${phase}`, idempotencyKey: 'visit-source', producedBy };
  const actualWrite = jest.requireActual<typeof storage>('@/utils/storage/backend').writeFileAtomic;
  const atomic = jest.mocked(storage.writeFileAtomic).mockImplementationOnce(async (...args) => {
    if (phase === 'after') await actualWrite(...args);
    throw new Error('index acknowledgement failed');
  });
  const open = jest.spyOn(fs, 'open');
  try {
    await expect(copyRunResourceToConversation(input)).rejects.toThrow('index acknowledgement failed');
    atomic.mockImplementation(actualWrite);
    const files = await fs.readdir(path.join(tmpDir, input.conversationId));
    const payloads = files.filter(filename => filename.endsWith('.dat'));
    expect(payloads).toHaveLength(1);
    const retry = await copyRunResourceToConversation(input) as RunResourceEntry;
    expect(`${retry.id}.dat`).toBe(payloads[0]);
    expect(await listRunResources(input.conversationId)).toHaveLength(1);
    expect(open.mock.calls.filter(([filename, flags]) => String(filename).endsWith(payloads[0]) && flags === 'wx')).toHaveLength(1);
  } finally { atomic.mockImplementation(actualWrite); open.mockRestore(); }
});

it('keeps durable memory outside optional spill quotas without weakening ordinary capture limits', async () => {
  const memory = await writeRunResource({ conversationId: 'memory-quota', kind: 'text',
    data: { text: 'x'.repeat(4096) }, producedBy: { source: 'compaction-artifact' } });
  expect(memory).not.toHaveProperty('skipped');
  const capture = await writeRunResource({ conversationId: 'memory-quota', kind: 'text',
    data: { text: 'x'.repeat(1024) }, producedBy });
  expect(capture).not.toHaveProperty('skipped');
  const oversized = await writeRunResource({ conversationId: 'memory-quota', kind: 'text',
    data: { text: 'x'.repeat(1025) }, producedBy });
  expect(oversized).toEqual({ skipped: 'size-cap' });
});

it('retains a durable summary and its older captured payloads across the age sweep', async () => {
  const raw = await writeRunResource({ conversationId: 'durable-memory', kind: 'text',
    data: { text: 'Exact old observation' }, producedBy: { source: 'tool-result' } }) as RunResourceEntry;
  const summary = await writeRunResource({ conversationId: 'durable-memory', kind: 'text',
    data: { text: 'Original: ' + raw.uri }, producedBy: { source: 'compaction-artifact' } }) as RunResourceEntry;
  const disposable = await writeRunResource({ conversationId: 'disposable-spill', kind: 'text',
    data: { text: 'Old unreferenced spill' }, producedBy: { source: 'tool-result' } }) as RunResourceEntry;
  await sweepOldRunResources(Date.now() + 30 * 86_400_000);
  expect(await readRunResource(raw.uri)).not.toBeNull();
  expect(await readRunResource(summary.uri)).not.toBeNull();
  expect(await readRunResource(disposable.uri)).toBeNull();
  await deleteRunResources('durable-memory');
  expect(await listRunResources('durable-memory')).toEqual([]);
});

describe('URI build/parse', () => {
  it('round-trips', () => {
    const uri = buildRunResourceUri('conv-1', 'abc-123');
    expect(uri).toBe('flujo://run/conv-1/abc-123');
    expect(parseRunResourceUri(uri)).toEqual({ conversationId: 'conv-1', id: 'abc-123' });
  });

  it('rejects foreign and malformed URIs', () => {
    expect(parseRunResourceUri('file:///etc/passwd')).toBeNull();
    expect(parseRunResourceUri('flujo://run/onlyone')).toBeNull();
    expect(parseRunResourceUri('flujo://run/a/b/c')).toBeNull();
    // Path-traversal shaped segments never parse.
    expect(parseRunResourceUri('flujo://run/../evil')).toBeNull();
    expect(parseRunResourceUri('flujo://run/conv/..%2Fescape')).toBeNull();
  });
});

describe('write/read/list round-trip', () => {
  it('stores text and reads it back in MCP contents shape with readBy lineage', async () => {
    const written = await writeRunResource({
      conversationId: 'convA',
      name: 'report',
      mimeType: 'text/markdown',
      kind: 'text',
      data: { text: '# hello' },
      producedBy,
    });
    expect('skipped' in written).toBe(false);
    const entry = written as RunResourceEntry;
    expect(entry.uri).toBe(buildRunResourceUri('convA', entry.id));
    expect(entry.size).toBe(7);

    const read = await readRunResource(entry.uri, { at: 123, source: 'res-ref', nodeId: 'node-2' });
    expect(read).not.toBeNull();
    expect(read!.contents.contents[0]).toMatchObject({ uri: entry.uri, mimeType: 'text/markdown', text: '# hello' });
    // Lineage: the access was appended.
    expect(read!.entry.readBy).toEqual([{ at: 123, source: 'res-ref', nodeId: 'node-2' }]);

    const listed = await listRunResources('convA');
    expect(listed.map((e) => e.id)).toContain(entry.id);
    expect(await findRunResourceByName('convA', 'report')).toMatchObject({ id: entry.id });
  });

  it('stores binary as base64 and serves it back as a blob', async () => {
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]).toString('base64');
    const written = await writeRunResource({
      conversationId: 'convA',
      mimeType: 'image/png',
      kind: 'image',
      data: { base64: payload },
      producedBy: { source: 'tool-result', server: 'srv', toolName: 'shot', toolCallId: 'call1' },
    });
    const entry = written as RunResourceEntry;
    expect(entry.size).toBe(6);
    const read = await readRunResource(entry.uri);
    expect(read!.contents.contents[0]).toMatchObject({ mimeType: 'image/png', blob: payload });
    // No access arg → no lineage append.
    expect(read!.entry.readBy).toEqual([]);
  });

  it('reads exact byte pages without hydrating the complete resource', async () => {
    const payload = '0123456789abcdefghijklmnopqrstuvwxyz';
    const written = await writeRunResource({
      conversationId: 'convRange',
      mimeType: 'text/plain',
      kind: 'text',
      data: { text: payload },
      producedBy,
    }) as RunResourceEntry;

    const page = await readRunResourceRange(
      written.uri,
      10,
      19,
      { at: 456, source: 'res-ref' },
    );
    expect(page).not.toBeNull();
    expect(page!.data.toString('utf8')).toBe('abcdefghij');
    expect(page).toMatchObject({ start: 10, end: 19, total: payload.length });
    expect((await listRunResources('convRange'))[0].readBy).toContainEqual({
      at: 456,
      source: 'res-ref',
    });
  });

  it('unknown uri reads as null', async () => {
    expect(await readRunResource(buildRunResourceUri('convA', 'no-such-id'))).toBeNull();
    expect(await readRunResource('flujo://run/never-seen-conv/no-such-id')).toBeNull();
  });
});

describe('capture → durable reload → read_resource round-trip (#368)', () => {
  it('reads the exact substituted payload after a cold reload and keeps conversation authorization', async () => {
    const conversationId = 'capture-resume-conv';
    const originalText = 'durable tool output '.repeat(20);
    const result: CallToolResult = { content: [{ type: 'text', text: originalText }] };
    const captured = await captureToolResult({
      conversationId,
      server: 'filesystem',
      toolName: 'read_file',
      toolCallId: 'call-capture-resume',
      result,
      settings: {
        ...DEFAULT_RUN_RESOURCE_SETTINGS,
        textThresholdChars: 10,
        replaceLargeTextWithStub: true,
      },
    });

    expect(captured.captured).toHaveLength(1);
    const marker = (captured.result.content[0] as { text?: string }).text ?? '';
    const uri = marker.match(/flujo:\/\/run\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/)?.[0];
    expect(uri).toBe(captured.captured[0].uri);
    expect(parseRunResourceUri(uri!)).toEqual({
      conversationId,
      id: captured.captured[0].id,
    });

    // Simulate process-memory loss at a resume boundary. Pointing the store at
    // the same durable directory clears its in-memory index cache.
    _setRunResourcesDirForTests(tmpDir);

    const resumed = await executeRunResourceTool(
      READ_RESOURCE_TOOL_NAME,
      { uri },
      { conversationId },
    );
    expect(resumed).toMatchObject({ success: true, data: { uri, content: originalText } });

    const denied = await executeRunResourceTool(
      READ_RESOURCE_TOOL_NAME,
      { uri },
      { conversationId: 'different-conversation' },
    );
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('not part of this run');
  });
});

describe('cross-conversation promotion', () => {
  it('copies binary bytes into the parent scope and exposes a validated local path', async () => {
    const payloadBytes = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
    const source = await writeRunResource({
      conversationId: 'child-media',
      mimeType: 'video/mp4',
      kind: 'blob',
      data: { base64: payloadBytes.toString('base64') },
      producedBy: { source: 'model-output', nodeId: 'video-node' },
    }) as RunResourceEntry;

    const promoted = await copyRunResourceToConversation({
      uri: source.uri,
      conversationId: 'parent-media',
      producedBy: { source: 'capture', nodeId: 'subflow-node' },
    }) as RunResourceEntry;

    expect(promoted.uri).not.toBe(source.uri);
    expect(promoted.conversationId).toBe('parent-media');
    expect(promoted).toMatchObject({ mimeType: 'video/mp4', kind: 'blob', size: payloadBytes.length });
    expect(promoted.origin).toEqual({ server: 'flujo', uri: source.uri });

    const parentRead = await readRunResource(promoted.uri);
    expect((parentRead!.contents.contents[0] as { blob?: string }).blob).toBe(payloadBytes.toString('base64'));

    const localPath = await getRunResourceLocalPath(promoted.uri);
    expect(localPath).not.toBeNull();
    expect(path.isAbsolute(localPath!)).toBe(true);
    expect(path.extname(localPath!)).toBe('.mp4');
    expect(await fs.readFile(localPath!)).toEqual(payloadBytes);
  });

  it('returns null for malformed, missing, and payload-less resources', async () => {
    expect(await getRunResourceLocalPath('file:///tmp/not-a-run-resource')).toBeNull();
    expect(await getRunResourceLocalPath(buildRunResourceUri('missing-conv', 'missing-id'))).toBeNull();
    const link = await writeRunResource({
      conversationId: 'parent-media',
      kind: 'link',
      producedBy: { source: 'mcp-link', server: 'srv' },
      origin: { server: 'srv', uri: 'srv://remote/item' },
    }) as RunResourceEntry;
    expect(await getRunResourceLocalPath(link.uri)).toBeNull();
  });
});

describe('named overwrite', () => {
  it('replaces the previous entry with the same name (last write wins)', async () => {
    const first = await writeRunResource({
      conversationId: 'convB', name: 'artifact', kind: 'text', data: { text: 'v1' }, producedBy,
    }) as RunResourceEntry;
    const second = await writeRunResource({
      conversationId: 'convB', name: 'artifact', kind: 'text', data: { text: 'v2' }, producedBy,
    }) as RunResourceEntry;

    const listed = await listRunResources('convB');
    expect(listed.filter((e) => e.name === 'artifact')).toHaveLength(1);
    expect((await findRunResourceByName('convB', 'artifact'))!.id).toBe(second.id);
    // The stale entry (and payload) is gone.
    expect(await readRunResource(first.uri)).toBeNull();
    const read = await readRunResource(second.uri);
    expect(read!.contents.contents[0]).toMatchObject({ text: 'v2' });
  });
});

describe('caps (never throw — capture must not break a run)', () => {
  it('skips a payload over maxResourceBytes', async () => {
    const written = await writeRunResource({
      conversationId: 'convC', kind: 'text', data: { text: 'x'.repeat(2000) }, producedBy,
    });
    expect(written).toEqual({ skipped: 'size-cap' });
    expect(await listRunResources('convC')).toHaveLength(0);
  });

  it('skips once the conversation budget is exhausted', async () => {
    const chunk = 'y'.repeat(1000);
    expect('skipped' in await writeRunResource({
      conversationId: 'convD', kind: 'text', data: { text: chunk }, producedBy,
    })).toBe(false);
    expect('skipped' in await writeRunResource({
      conversationId: 'convD', kind: 'text', data: { text: chunk }, producedBy,
    })).toBe(false);
    // 2000/2048 used; another 1000 must be refused.
    expect(await writeRunResource({
      conversationId: 'convD', kind: 'text', data: { text: chunk }, producedBy,
    })).toEqual({ skipped: 'conversation-cap' });
    expect(await listRunResources('convD')).toHaveLength(2);
  });

  it('a named overwrite does not double-count the replaced entry against the budget', async () => {
    const chunk = 'z'.repeat(1000);
    await writeRunResource({ conversationId: 'convE', name: 'big', kind: 'text', data: { text: chunk }, producedBy });
    await writeRunResource({ conversationId: 'convE', kind: 'text', data: { text: chunk }, producedBy });
    // Rewriting 'big' frees its old 1000 bytes first: 1000 (other) + 1000 (new) fits 2048.
    const rewrite = await writeRunResource({
      conversationId: 'convE', name: 'big', kind: 'text', data: { text: chunk }, producedBy,
    });
    expect('skipped' in rewrite).toBe(false);
  });
});

describe('path safety', () => {
  it('refuses unsafe conversation ids', async () => {
    await expect(writeRunResource({
      conversationId: '../escape', kind: 'text', data: { text: 'x' }, producedBy,
    })).rejects.toThrow(/Unsafe run-resource/);
    await expect(listRunResources('a/b')).rejects.toThrow(/Unsafe run-resource/);
    await expect(deleteRunResources('..')).rejects.toThrow(/Unsafe run-resource/);
  });
});

describe('link entries', () => {
  it('stores a payload-less link pointing at its origin', async () => {
    const written = await writeRunResource({
      conversationId: 'convF', kind: 'link', mimeType: 'text/csv',
      producedBy: { source: 'mcp-link', server: 'srv', toolName: 't', toolCallId: 'c1' },
      origin: { server: 'srv', uri: 'srv://data/table.csv' },
    }) as RunResourceEntry;
    expect(written.size).toBe(0);
    const read = await readRunResource(written.uri);
    expect((read!.contents.contents[0] as { text?: string }).text).toContain('srv://data/table.csv');
  });
});

describe('listAllRunResources + delete', () => {
  it('lists across conversations newest-first and delete is idempotent', async () => {
    const all = await listAllRunResources();
    expect(all.length).toBeGreaterThan(0);
    // Newest-first ordering.
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].createdAt).toBeGreaterThanOrEqual(all[i].createdAt);
    }

    await deleteRunResources('convA');
    expect(await listRunResources('convA')).toHaveLength(0);
    await expect(deleteRunResources('convA')).resolves.toBeUndefined(); // idempotent
    // The directory is gone from disk.
    await expect(fs.access(path.join(tmpDir, 'convA'))).rejects.toThrow();
  });
});

it('refuses a ranged payload substituted with a directory before any descriptor read', async () => {
  const entry = await writeRunResource({ conversationId: 'nonregular_range', mimeType: 'text/plain', kind: 'text',
    data: { text: 'retained resource' }, producedBy }) as RunResourceEntry;
  const file = path.join(tmpDir, 'nonregular_range', `${entry.id}.dat`);
  const originalOpen = fs.open.bind(fs);
  const reads: jest.Mock[] = [];
  let swapped = false;
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === file && !swapped) {
      swapped = true;
      await fs.unlink(file);
      await fs.mkdir(file);
    }
    const handle = await originalOpen(...args);
    if (String(args[0]) === file) {
      const read = jest.fn(handle.read.bind(handle));
      handle.read = read;
      reads.push(read);
    }
    return handle;
  });
  try {
    expect(await readRunResourceRange(entry.uri, 0, 4)).toBeNull();
    expect(swapped).toBe(true);
    expect(reads.every(read => read.mock.calls.length === 0)).toBe(true);
  } finally { jest.restoreAllMocks(); }
});
