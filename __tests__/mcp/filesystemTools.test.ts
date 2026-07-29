/**
 * Tests for the built-in `filesystem` MCP server (issue #170): round-trip
 * read/write, line-range read, diff editing, dir listing + depth-limited tree,
 * search by name/content, create/move/delete, and FLUJO_FS_ROOTS confinement.
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

jest.mock('@/backend/services/mcp/internal/registry', () => ({
  FILESYSTEM_SERVER_NAME: 'filesystem',
  getInternalServerRoots: jest.fn(),
}));

// `filesystemResources.ts` imports the ESM-only `@modelcontextprotocol/ext-apps`
// package, which Jest cannot transpile. Mock the single constant it needs (same
// approach as filesystemApp.test.ts).
jest.mock('@modelcontextprotocol/ext-apps', () => ({
  LATEST_PROTOCOL_VERSION: '2026-01-26',
}));

import { getInternalServerRoots } from '@/backend/services/mcp/internal/registry';
import { filesystemToolDefinitions, filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';
import {
  filesystemListResources,
  isTouchedFileUri,
  readTouchedFileResource,
  _clearTouchedFilesForTests,
} from '@/backend/services/mcp/internal/filesystemResources';

const mockedRoots = getInternalServerRoots as jest.Mock;

function text(r: CallToolResult): string {
  const first = r.content[0] as { text: string };
  return first.text;
}
function parse(r: CallToolResult): Record<string, unknown> {
  return JSON.parse(text(r));
}
function structured(r: CallToolResult): Record<string, unknown> | undefined {
  return (r as { structuredContent?: Record<string, unknown> }).structuredContent;
}

describe('filesystem tool definitions', () => {
  it('exposes the expected tool set', () => {
    const names = filesystemToolDefinitions().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'dir_tree',
        'search',
        'get_file_info',
        'create_directory',
        'move',
        'delete',
      ])
    );
  });

  it('exposes get_allowed_directories', () => {
    const names = filesystemToolDefinitions().map((t) => t.name);
    expect(names).toContain('get_allowed_directories');
  });

  it('advertises accurate read and destructive-write annotations', () => {
    const definitions = new Map(filesystemToolDefinitions().map((tool) => [tool.name, tool]));

    expect(definitions.get('list_dir')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(definitions.get('get_allowed_directories')?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(definitions.get('create_directory')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(definitions.get('delete')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });
});

describe('filesystem operations', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-fs-'));
    mockedRoots.mockResolvedValue([dir]);
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    mockedRoots.mockReset();
  });

  it('writes and reads a file round-trip', async () => {
    const p = path.join(dir, 'a.txt');
    const w = await filesystemCallTool('write_file', { path: p, content: 'line1\nline2\nline3\n' });
    expect(w.isError).toBeUndefined();
    const out = parse(await filesystemCallTool('read_file', { path: p }));
    expect(out.totalLines as number).toBeGreaterThanOrEqual(3);
    expect(out.content as string).toContain('line2');
  });

  it('reads a specific line range', async () => {
    const p = path.join(dir, 'b.txt');
    await filesystemCallTool('write_file', { path: p, content: 'a\nb\nc\nd\ne\n' });
    const out = parse(await filesystemCallTool('read_file', { path: p, from: 2, to: 3 }));
    expect(out.content).toBe('b\nc');
    expect(out.from).toBe(2);
    expect(out.to).toBe(3);
  });

  it('applies a diff edit and rejects a missing oldText', async () => {
    const p = path.join(dir, 'c.txt');
    await filesystemCallTool('write_file', { path: p, content: 'hello world' });
    const ok = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'world', newText: 'flujo' }] });
    expect(ok.isError).toBeUndefined();
    expect(parse(await filesystemCallTool('read_file', { path: p })).content).toBe('hello flujo');
    const bad = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'nope', newText: 'x' }] });
    expect(bad.isError).toBe(true);
  });

  it('lists a directory and builds a depth-limited tree', async () => {
    await fsp.mkdir(path.join(dir, 'sub'));
    await fsp.writeFile(path.join(dir, 'top.txt'), 'x');
    await fsp.writeFile(path.join(dir, 'sub', 'deep.txt'), 'y');
    const list = parse(await filesystemCallTool('list_dir', { path: dir }));
    const listNames = (list.entries as Array<{ name: string }>).map((e) => e.name);
    expect(listNames).toEqual(expect.arrayContaining(['sub', 'top.txt']));

    const tree = parse(await filesystemCallTool('dir_tree', { path: dir, depth: 2 }));
    const nodes = tree.tree as Array<{ name: string; children?: Array<{ name: string }> }>;
    const sub = nodes.find((n) => n.name === 'sub');
    expect(sub?.children?.map((n) => n.name)).toContain('deep.txt');
  });

  it('searches by name and by content', async () => {
    await fsp.writeFile(path.join(dir, 'needle.txt'), 'find the FOO here');
    const byName = parse(await filesystemCallTool('search', { path: dir, namePattern: 'needle' }));
    expect((byName.matches as unknown[]).length).toBeGreaterThanOrEqual(1);
    const byContent = parse(await filesystemCallTool('search', { path: dir, content: 'foo' }));
    expect((byContent.matches as Array<{ line: number }>)[0].line).toBe(1);
  });

  it('creates, moves and deletes', async () => {
    const madeDir = path.join(dir, 'made');
    expect((await filesystemCallTool('create_directory', { path: madeDir })).isError).toBeUndefined();
    const src = path.join(dir, 'src.txt');
    const dst = path.join(dir, 'dst.txt');
    await fsp.writeFile(src, 'z');
    expect((await filesystemCallTool('move', { source: src, destination: dst })).isError).toBeUndefined();
    expect((await filesystemCallTool('delete', { path: dst })).isError).toBeUndefined();
    const info = await filesystemCallTool('get_file_info', { path: madeDir });
    expect(parse(info).isDirectory).toBe(true);
  });

  it('returns structured content alongside the text fallback', async () => {
    const p = path.join(dir, 'struct.txt');
    await filesystemCallTool('write_file', { path: p, content: 'x\ny\n' });
    const r = await filesystemCallTool('read_file', { path: p });
    const sc = structured(r);
    expect(sc).toBeDefined();
    // structuredContent must mirror the JSON text fallback exactly.
    expect(sc).toEqual(parse(r));
    expect((sc as { totalLines: number }).totalLines).toBeGreaterThanOrEqual(2);
  });

  it('write_file appends, inserts and replaces a line range', async () => {
    const p = path.join(dir, 'lt.txt');
    await filesystemCallTool('write_file', { path: p, content: 'a\nb\nc\n' });

    // append
    await filesystemCallTool('write_file', { path: p, content: 'z', mode: 'append' });
    expect(parse(await filesystemCallTool('read_file', { path: p })).content).toBe('a\nb\nc\nz');

    // insert before line 1
    await filesystemCallTool('write_file', { path: p, content: 'HEAD', mode: 'insert', startLine: 1 });
    expect(parse(await filesystemCallTool('read_file', { path: p })).content).toBe('HEAD\na\nb\nc\nz');

    // overwrite line range 2..3 (a,b) with a single line
    await filesystemCallTool('write_file', { path: p, content: 'MID', startLine: 2, endLine: 3 });
    expect(parse(await filesystemCallTool('read_file', { path: p })).content).toBe('HEAD\nMID\nc\nz');
  });

  it('edit_file scopes a literal edit to a line range to disambiguate', async () => {
    const p = path.join(dir, 'scoped.txt');
    await filesystemCallTool('write_file', { path: p, content: 'foo\nfoo\nfoo\n' });
    // Unscoped edit of an ambiguous token is rejected.
    const ambiguous = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'foo', newText: 'bar' }] });
    expect(ambiguous.isError).toBe(true);
    // Scoping to line 2 makes it unambiguous.
    const ok = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'foo', newText: 'bar', startLine: 2, endLine: 2 }] });
    expect(ok.isError).toBeUndefined();
    expect(parse(await filesystemCallTool('read_file', { path: p })).content).toBe('foo\nbar\nfoo\n');
  });

  it('edit_file applies a unified diff and rejects a context mismatch', async () => {
    const p = path.join(dir, 'diff.txt');
    await filesystemCallTool('write_file', { path: p, content: 'one\ntwo\nthree\n' });
    const goodDiff = ['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''].join('\n');
    const applied = await filesystemCallTool('edit_file', { path: p, diff: goodDiff });
    expect(applied.isError).toBeUndefined();
    expect((parse(applied).diff as { added: number; removed: number })).toEqual({ added: 1, removed: 1 });
    expect(parse(await filesystemCallTool('read_file', { path: p })).content).toContain('TWO');

    // A diff whose context does not match the file is rejected with no write.
    const badDiff = ['@@ -1,2 +1,2 @@', ' NOPE', '-TWO', '+X', ''].join('\n');
    const before = parse(await filesystemCallTool('read_file', { path: p })).content;
    const rejected = await filesystemCallTool('edit_file', { path: p, diff: badDiff });
    expect(rejected.isError).toBe(true);
    expect(parse(await filesystemCallTool('read_file', { path: p })).content).toBe(before);
  });

  it('edit_file rejects diff and edits together', async () => {
    const p = path.join(dir, 'mutex.txt');
    await filesystemCallTool('write_file', { path: p, content: 'a\n' });
    const r = await filesystemCallTool('edit_file', {
      path: p,
      diff: '@@ -1 +1 @@\n-a\n+b\n',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not both/i);
  });

  // --- CR/CRLF line-break resilience (issue #187) ---
  it('edit_file matches an LF oldText against a CRLF file and preserves CRLF', async () => {
    const p = path.join(dir, 'crlf.txt');
    // overwrite mode writes bytes verbatim, so this is a genuine CRLF file.
    await filesystemCallTool('write_file', { path: p, content: 'alpha\r\nbeta\r\ngamma\r\n' });
    const ok = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'beta', newText: 'BETA' }] });
    expect(ok.isError).toBeUndefined();
    // Read raw bytes (not the normalized read_file view) to assert EOL preservation.
    const raw = await fsp.readFile(p, 'utf8');
    expect(raw).toBe('alpha\r\nBETA\r\ngamma\r\n');
    expect(raw).not.toMatch(/[^\r]\n/); // no lone LF slipped in
  });

  it('edit_file matches a CRLF oldText against an LF file and preserves LF', async () => {
    const p = path.join(dir, 'lf.txt');
    await filesystemCallTool('write_file', { path: p, content: 'alpha\nbeta\ngamma\n' });
    // Model supplies CRLF in oldText/newText though the file uses LF.
    const ok = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'alpha\r\nbeta', newText: 'A\r\nB' }] });
    expect(ok.isError).toBeUndefined();
    const raw = await fsp.readFile(p, 'utf8');
    expect(raw).toBe('A\nB\ngamma\n');
    expect(raw).not.toContain('\r');
  });

  it('edit_file matches a multi-line oldText spanning a CRLF boundary', async () => {
    const p = path.join(dir, 'multi.txt');
    await filesystemCallTool('write_file', { path: p, content: 'one\r\ntwo\r\nthree\r\n' });
    const ok = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'one\ntwo', newText: 'ONE\nTWO' }] });
    expect(ok.isError).toBeUndefined();
    const raw = await fsp.readFile(p, 'utf8');
    expect(raw).toBe('ONE\r\nTWO\r\nthree\r\n');
  });

  it('edit_file scopes a line-range edit on a CRLF file (regionOffsets)', async () => {
    const p = path.join(dir, 'scoped-crlf.txt');
    await filesystemCallTool('write_file', { path: p, content: 'foo\r\nfoo\r\nfoo\r\n' });
    const ok = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'foo', newText: 'bar', startLine: 2, endLine: 2 }] });
    expect(ok.isError).toBeUndefined();
    const raw = await fsp.readFile(p, 'utf8');
    expect(raw).toBe('foo\r\nbar\r\nfoo\r\n');
  });

  describe('get_allowed_directories', () => {
    it('returns the effective roots', async () => {
      // mockedRoots is already set to [dir] in beforeEach
      const result = await filesystemCallTool('get_allowed_directories', {});
      expect(result.isError).toBeFalsy();
      const sc = structured(result) as { directories: string[] };
      expect(sc.directories).toEqual([dir]);
    });

    it('returns the data-directory fallback when no user roots are configured', async () => {
      // When getInternalServerRoots returns [] and no FLUJO_FS_ROOTS env is set,
      // loadEffectiveRoots falls back to [getDataDir()] so the file browser is
      // still usable by default. The tool must NOT return an error in this case.
      mockedRoots.mockResolvedValueOnce([]);
      const result = await filesystemCallTool('get_allowed_directories', {});
      expect(result.isError).toBeFalsy();
      const sc = structured(result) as { directories: string[] };
      // At least one directory (the data dir fallback) must be present.
      expect(Array.isArray(sc.directories)).toBe(true);
      expect(sc.directories.length).toBeGreaterThan(0);
    });
  });

  it('enforces FLUJO_FS_ROOTS confinement when configured', async () => {
    const prev = process.env.FLUJO_FS_ROOTS;
    process.env.FLUJO_FS_ROOTS = dir;
    try {
      const outside = path.join(os.tmpdir(), `flujo-outside-${Date.now()}.txt`);
      const r = await filesystemCallTool('write_file', { path: outside, content: 'x' });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/outside/i);
      // A path INSIDE the root is still allowed.
      const inside = await filesystemCallTool('write_file', { path: path.join(dir, 'ok.txt'), content: 'x' });
      expect(inside.isError).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.FLUJO_FS_ROOTS;
      else process.env.FLUJO_FS_ROOTS = prev;
    }
  });
});

// --- #254: TOCTOU compare-and-swap guard + BOM preservation ---
describe('filesystem #254 TOCTOU guard + BOM', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-fs254-'));
    mockedRoots.mockResolvedValue([dir]);
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    mockedRoots.mockReset();
  });

  it('read_file returns a stable contentHash', async () => {
    const p = path.join(dir, 'h.txt');
    await filesystemCallTool('write_file', { path: p, content: 'hello\nworld\n' });
    const a = parse(await filesystemCallTool('read_file', { path: p }));
    const b = parse(await filesystemCallTool('read_file', { path: p }));
    expect(typeof a.contentHash).toBe('string');
    expect((a.contentHash as string).length).toBe(64);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('edit_file rejects a stale expectedHash and leaves the file unchanged', async () => {
    const p = path.join(dir, 'toctou.txt');
    await filesystemCallTool('write_file', { path: p, content: 'alpha\nbeta\ngamma\n' });
    const read = parse(await filesystemCallTool('read_file', { path: p }));
    const staleHash = read.contentHash as string;

    // Simulate a concurrent change on disk during the approval window.
    await fsp.writeFile(p, 'alpha\nBETA-CHANGED\ngamma\n', 'utf8');

    const r = await filesystemCallTool('edit_file', {
      path: p,
      expectedHash: staleHash,
      edits: [{ oldText: 'beta', newText: 'BETA' }],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/changed after permission approval/i);
    expect(text(r)).toMatch(/no changes written/i);
    // The concurrent content must remain untouched.
    expect(await fsp.readFile(p, 'utf8')).toBe('alpha\nBETA-CHANGED\ngamma\n');
  });

  it('edit_file applies when expectedHash matches the current file', async () => {
    const p = path.join(dir, 'match.txt');
    await filesystemCallTool('write_file', { path: p, content: 'alpha\nbeta\ngamma\n' });
    const read = parse(await filesystemCallTool('read_file', { path: p }));
    const r = await filesystemCallTool('edit_file', {
      path: p,
      expectedHash: read.contentHash as string,
      edits: [{ oldText: 'beta', newText: 'BETA' }],
    });
    expect(r.isError).toBeUndefined();
    expect(await fsp.readFile(p, 'utf8')).toBe('alpha\nBETA\ngamma\n');
  });

  it('edit_file is unchanged (backward-compatible) when expectedHash is omitted', async () => {
    const p = path.join(dir, 'compat.txt');
    await filesystemCallTool('write_file', { path: p, content: 'alpha\nbeta\ngamma\n' });
    const r = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'beta', newText: 'BETA' }] });
    expect(r.isError).toBeUndefined();
    expect(await fsp.readFile(p, 'utf8')).toBe('alpha\nBETA\ngamma\n');
  });

  it('write_file range-overwrite honors a stale expectedHash', async () => {
    const p = path.join(dir, 'wf-toctou.txt');
    await filesystemCallTool('write_file', { path: p, content: 'a\nb\nc\n' });
    const read = parse(await filesystemCallTool('read_file', { path: p }));
    await fsp.writeFile(p, 'a\nCHANGED\nc\n', 'utf8');
    const r = await filesystemCallTool('write_file', {
      path: p,
      content: 'MID',
      startLine: 2,
      endLine: 2,
      expectedHash: read.contentHash as string,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/changed after permission approval/i);
    expect(await fsp.readFile(p, 'utf8')).toBe('a\nCHANGED\nc\n');
  });

  it('write_file append honors a matching expectedHash', async () => {
    const p = path.join(dir, 'wf-append.txt');
    await filesystemCallTool('write_file', { path: p, content: 'a\nb\n' });
    const read = parse(await filesystemCallTool('read_file', { path: p }));
    const r = await filesystemCallTool('write_file', {
      path: p,
      content: 'c',
      mode: 'append',
      expectedHash: read.contentHash as string,
    });
    expect(r.isError).toBeUndefined();
    expect(await fsp.readFile(p, 'utf8')).toBe('a\nb\nc');
  });

  it('edit_file preserves a leading UTF-8 BOM and matches the body', async () => {
    const p = path.join(dir, 'bom.txt');
    // Write a genuine BOM file via overwrite (verbatim bytes).
    await filesystemCallTool('write_file', { path: p, content: '﻿alpha\nbeta\ngamma\n' });
    const ok = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'beta', newText: 'BETA' }] });
    expect(ok.isError).toBeUndefined();
    const raw = await fsp.readFile(p, 'utf8');
    expect(raw.startsWith('﻿')).toBe(true);
    expect(raw).toBe('﻿alpha\nBETA\ngamma\n');
  });

  it('edit_file preserves a BOM on a CRLF file too', async () => {
    const p = path.join(dir, 'bom-crlf.txt');
    await filesystemCallTool('write_file', { path: p, content: '﻿alpha\r\nbeta\r\ngamma\r\n' });
    const ok = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'beta', newText: 'BETA' }] });
    expect(ok.isError).toBeUndefined();
    const raw = await fsp.readFile(p, 'utf8');
    expect(raw).toBe('﻿alpha\r\nBETA\r\ngamma\r\n');
  });

  it('write_file append preserves a leading BOM', async () => {
    const p = path.join(dir, 'bom-append.txt');
    await filesystemCallTool('write_file', { path: p, content: '﻿a\nb\n' });
    const r = await filesystemCallTool('write_file', { path: p, content: 'c', mode: 'append' });
    expect(r.isError).toBeUndefined();
    const raw = await fsp.readFile(p, 'utf8');
    expect(raw.startsWith('﻿')).toBe(true);
    expect(raw).toBe('﻿a\nb\nc');
  });
});

// --- #287: large-file read guard, in-file search, resource exposure ---
describe('filesystem #287 enhancements', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-fs287-'));
    mockedRoots.mockResolvedValue([dir]);
    _clearTouchedFilesForTests();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    mockedRoots.mockReset();
    _clearTouchedFilesForTests();
  });

  it('read_file: large whole-file read without a pattern is rejected with guidance', async () => {
    const p = path.join(dir, 'big.txt');
    // > 100 KB of content across many lines.
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i} some filler text here`).join('\n');
    await fsp.writeFile(p, big);
    const r = await filesystemCallTool('read_file', { path: p });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/large/i);
    expect(text(r)).toMatch(/pattern/i);
  });

  it('read_file: pattern "*" force-reads a large file whole', async () => {
    const p = path.join(dir, 'big2.txt');
    const big = Array.from({ length: 4000 }, (_, i) => `row ${i} ${'x'.repeat(40)}`).join('\n');
    await fsp.writeFile(p, big);
    expect((await fsp.stat(p)).size).toBeGreaterThan(100_000);
    const out = parse(await filesystemCallTool('read_file', { path: p, pattern: '*' }));
    expect(out.content as string).toContain('row 0');
    expect(out.totalLines as number).toBeGreaterThanOrEqual(4000);
  });

  it('read_file: a real pattern greps a large file and returns matching lines only', async () => {
    const p = path.join(dir, 'big3.txt');
    const lines = Array.from({ length: 4000 }, (_, i) => (i === 1234 ? 'THE_NEEDLE_HERE' : `pad ${i} ${'y'.repeat(40)}`));
    await fsp.writeFile(p, lines.join('\n'));
    expect((await fsp.stat(p)).size).toBeGreaterThan(100_000);
    const out = parse(await filesystemCallTool('read_file', { path: p, pattern: 'THE_NEEDLE_HERE' }));
    const matches = out.matches as Array<{ line: number; text: string }>;
    expect(matches.length).toBe(1);
    expect(matches[0].line).toBe(1235); // 1-based
    // The excerpt is line-numbered and does not include the whole file.
    expect(out.content as string).toContain('1235: THE_NEEDLE_HERE');
    // The excerpt is a small window, not the ~28 KB whole file.
    expect((out.content as string).length).toBeLessThan(5000);
  });

  it('read_file: small files and explicit ranges are unaffected by the guard', async () => {
    const p = path.join(dir, 'small.txt');
    await filesystemCallTool('write_file', { path: p, content: 'a\nb\nc\n' });
    // whole-read of a small file: no pattern needed.
    expect((await filesystemCallTool('read_file', { path: p })).isError).toBeUndefined();
    // explicit range even on a (hypothetically) large file bypasses the guard.
    const out = parse(await filesystemCallTool('read_file', { path: p, from: 1, to: 2 }));
    expect(out.content).toBe('a\nb');
  });

  it('search: matches inside file contents with correct path and 1-based line', async () => {
    await fsp.mkdir(path.join(dir, 'nested'));
    await fsp.writeFile(path.join(dir, 'nested', 'doc.txt'), 'first\nSECOND has the token\nthird');
    const out = parse(await filesystemCallTool('search', { path: dir, content: 'token' }));
    const matches = out.matches as Array<{ path: string; line: number; text: string }>;
    expect(matches.length).toBe(1);
    expect(matches[0].line).toBe(2);
    expect(matches[0].path).toContain('doc.txt');
  });

  it('search: skips likely-binary files during content scan', async () => {
    // A file with a NUL byte should be treated as binary and skipped.
    await fsp.writeFile(path.join(dir, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42, 0x74, 0x6f, 0x6b])); // contains "tok" but a NUL
    await fsp.writeFile(path.join(dir, 'text.txt'), 'plain tok here');
    const out = parse(await filesystemCallTool('search', { path: dir, content: 'tok' }));
    const matches = out.matches as Array<{ path: string }>;
    expect(matches.some((m) => m.path.endsWith('text.txt'))).toBe(true);
    expect(matches.some((m) => m.path.endsWith('bin.dat'))).toBe(false);
  });

  it('resources: a written and a read file are tracked and retrievable', async () => {
    const wp = path.join(dir, 'written.txt');
    await filesystemCallTool('write_file', { path: wp, content: 'hello resource' });
    const rp = path.join(dir, 'toread.txt');
    await fsp.writeFile(rp, 'read me back');
    await filesystemCallTool('read_file', { path: rp });

    const list = filesystemListResources();
    const uris = list.resources.map((r) => r.uri);
    // Both tracked files show up as file:// resources.
    const written = list.resources.find((r) => r.uri.includes('written.txt'));
    const readEntry = list.resources.find((r) => r.uri.includes('toread.txt'));
    expect(written).toBeDefined();
    expect(readEntry).toBeDefined();
    expect(uris).toEqual(expect.arrayContaining(['ui://filesystem/browser']));

    // The tracked URI reads back the current content live.
    expect(isTouchedFileUri(written!.uri)).toBe(true);
    const readback = await readTouchedFileResource(written!.uri);
    expect(readback.success).toBe(true);
    const content0 = readback.data?.contents[0];
    expect(content0 && 'text' in content0 ? content0.text : undefined).toBe('hello resource');
  });

  it('resources: reading a file outside the roots is refused', async () => {
    const rp = path.join(dir, 'inside.txt');
    await fsp.writeFile(rp, 'x');
    await filesystemCallTool('read_file', { path: rp });
    const list = filesystemListResources();
    const entry = list.resources.find((r) => r.uri.includes('inside.txt'))!;
    // Narrow the roots to a different directory: the earlier-tracked file is now out of bounds.
    const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-other-'));
    mockedRoots.mockResolvedValue([other]);
    try {
      const res = await readTouchedFileResource(entry.uri);
      expect(res.success).toBe(false);
      expect(res.statusCode).toBe(403);
    } finally {
      await fsp.rm(other, { recursive: true, force: true });
    }
  });
});

// --- #254: TOCTOU compare-and-swap guard + BOM preservation ---
describe('filesystem #254 TOCTOU guard + BOM', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-fs254-'));
    mockedRoots.mockResolvedValue([dir]);
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    mockedRoots.mockReset();
  });

  it('read_file returns a contentHash', async () => {
    const p = path.join(dir, 'h.txt');
    await filesystemCallTool('write_file', { path: p, content: 'hello world\n' });
    const out = parse(await filesystemCallTool('read_file', { path: p }));
    expect(typeof out.contentHash).toBe('string');
    expect((out.contentHash as string).length).toBe(64); // sha256 hex
  });

  it('edit_file rejects a stale expectedHash and leaves the file unchanged', async () => {
    const p = path.join(dir, 'toctou.txt');
    await filesystemCallTool('write_file', { path: p, content: 'original one\ntwo\n' });
    const read = parse(await filesystemCallTool('read_file', { path: p }));
    const staleHash = read.contentHash as string;
    // Simulate a concurrent change during the approval window.
    await fsp.writeFile(p, 'CHANGED on disk\ntwo\n', 'utf8');
    const r = await filesystemCallTool('edit_file', {
      path: p,
      expectedHash: staleHash,
      edits: [{ oldText: 'two', newText: 'TWO' }],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/changed after permission approval/i);
    // On-disk file must be untouched (no clobber).
    expect(await fsp.readFile(p, 'utf8')).toBe('CHANGED on disk\ntwo\n');
  });

  it('edit_file applies normally when expectedHash matches', async () => {
    const p = path.join(dir, 'match.txt');
    await filesystemCallTool('write_file', { path: p, content: 'alpha\nbeta\n' });
    const read = parse(await filesystemCallTool('read_file', { path: p }));
    const r = await filesystemCallTool('edit_file', {
      path: p,
      expectedHash: read.contentHash as string,
      edits: [{ oldText: 'beta', newText: 'BETA' }],
    });
    expect(r.isError).toBeUndefined();
    expect(await fsp.readFile(p, 'utf8')).toBe('alpha\nBETA\n');
  });

  it('edit_file is backward-compatible when expectedHash is omitted', async () => {
    const p = path.join(dir, 'nohash.txt');
    await filesystemCallTool('write_file', { path: p, content: 'x\ny\n' });
    const r = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'y', newText: 'Y' }] });
    expect(r.isError).toBeUndefined();
    expect(await fsp.readFile(p, 'utf8')).toBe('x\nY\n');
  });

  it('edit_file preserves a leading UTF-8 BOM across an edit', async () => {
    const p = path.join(dir, 'bom.txt');
    const BOM = '﻿';
    // Write a genuine BOM file via overwrite (verbatim bytes).
    await filesystemCallTool('write_file', { path: p, content: `${BOM}first\nsecond\n` });
    const r = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'second', newText: 'SECOND' }] });
    expect(r.isError).toBeUndefined();
    const raw = await fsp.readFile(p, 'utf8');
    expect(raw.startsWith(BOM)).toBe(true);
    expect(raw).toBe(`${BOM}first\nSECOND\n`);
  });

  it('edit_file matches oldText at the very start of a BOM file (BOM stripped before match)', async () => {
    const p = path.join(dir, 'bom-start.txt');
    const BOM = '﻿';
    await filesystemCallTool('write_file', { path: p, content: `${BOM}first\nsecond\n` });
    // oldText "first" would fail to match if the BOM were glued to it.
    const r = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'first', newText: 'FIRST' }] });
    expect(r.isError).toBeUndefined();
    expect(await fsp.readFile(p, 'utf8')).toBe(`${BOM}FIRST\nsecond\n`);
  });

  it('write_file read-modify-write modes honor expectedHash', async () => {
    const p = path.join(dir, 'wf.txt');
    await filesystemCallTool('write_file', { path: p, content: 'a\nb\nc\n' });
    const staleHash = parse(await filesystemCallTool('read_file', { path: p })).contentHash as string;
    // Concurrent change.
    await fsp.writeFile(p, 'a\nb\nCHANGED\n', 'utf8');
    // append with the stale hash is rejected.
    const rej = await filesystemCallTool('write_file', { path: p, content: 'z', mode: 'append', expectedHash: staleHash });
    expect(rej.isError).toBe(true);
    expect(text(rej)).toMatch(/changed after permission approval/i);
    expect(await fsp.readFile(p, 'utf8')).toBe('a\nb\nCHANGED\n');
    // With the fresh hash it applies.
    const freshHash = parse(await filesystemCallTool('read_file', { path: p })).contentHash as string;
    const ok = await filesystemCallTool('write_file', { path: p, content: 'z', mode: 'append', expectedHash: freshHash });
    expect(ok.isError).toBeUndefined();
    expect(await fsp.readFile(p, 'utf8')).toBe('a\nb\nCHANGED\nz');
  });

  it('edit_file produces distinct actionable errors for not-found vs ambiguous', async () => {
    const p = path.join(dir, 'errs.txt');
    await filesystemCallTool('write_file', { path: p, content: 'foo\nfoo\nbar\n' });
    const notFound = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'nope', newText: 'x' }] });
    expect(notFound.isError).toBe(true);
    expect(text(notFound)).toMatch(/not found/i);
    const ambiguous = await filesystemCallTool('edit_file', { path: p, edits: [{ oldText: 'foo', newText: 'x' }] });
    expect(ambiguous.isError).toBe(true);
    expect(text(ambiguous)).toMatch(/ambiguous/i);
  });
});
