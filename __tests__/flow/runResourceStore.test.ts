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
import {
  writeRunResource,
  listRunResources,
  listAllRunResources,
  readRunResource,
  findRunResourceByName,
  deleteRunResources,
  buildRunResourceUri,
  parseRunResourceUri,
  _setRunResourcesDirForTests,
  _clearRunResourceSettingsCache,
} from '@/backend/services/runResources';
import type { RunResourceEntry } from '@/shared/types/runResources';

// Settings come from storage (loadItem). Pin them to defaults with a tight
// per-resource cap so the cap paths are testable without megabyte payloads.
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return {
    ...actual,
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

  it('unknown uri reads as null', async () => {
    expect(await readRunResource(buildRunResourceUri('convA', 'no-such-id'))).toBeNull();
    expect(await readRunResource('flujo://run/never-seen-conv/no-such-id')).toBeNull();
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
