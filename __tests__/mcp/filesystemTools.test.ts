/**
 * Tests for the shipped `filesystem` MCP package (issue #170): round-trip
 * read/write, line-range read, diff editing, dir listing + depth-limited tree,
 * search by name/content, create/move/delete, and FLUJO_FS_ROOTS confinement.
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn, type ChildProcess } from 'node:child_process';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: jest.fn(actual.spawn) };
});

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerRoots: jest.fn(),
}));

// `filesystemResources.ts` imports the ESM-only `@modelcontextprotocol/ext-apps`
// package, which Jest cannot transpile. Mock the single constant it needs (same
// approach as filesystemApp.test.ts).
jest.mock('@modelcontextprotocol/ext-apps', () => ({
  LATEST_PROTOCOL_VERSION: '2026-01-26',
}));

import { loadServerRoots } from '@/backend/services/mcp/config';
import {
  filesystemToolDefinitions,
  filesystemCallTool,
  _normalizeSlashDrivePathForTests,
  _setRipgrepExecutableForTests,
} from '@/backend/services/mcp/internal/filesystemTools';
import {
  filesystemListResources,
  isTouchedFileUri,
  readTouchedFileResource,
  _clearTouchedFilesForTests,
} from '@/backend/services/mcp/internal/filesystemResources';

const mockedRoots = loadServerRoots as jest.Mock;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

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

function mockRipgrepMatches(records: Array<{ path: string; line: number; text: string }>): void {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: null,
    pid: 12_345,
    killed: false,
    kill: jest.fn(() => true),
  }) as unknown as ChildProcess;
  mockedSpawn.mockImplementationOnce((() => {
    setImmediate(() => {
      for (const record of records) {
        stdout.write(`${JSON.stringify({
          type: 'match',
          data: {
            path: { text: record.path },
            lines: { text: `${record.text}\n` },
            line_number: record.line,
          },
        })}\n`);
      }
      stdout.end();
      stderr.end();
      child.emit('close', records.length ? 0 : 1);
    });
    return child;
  }) as typeof spawn);
}

function mockHangingRipgrep(): jest.Mock {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: null,
    pid: 12_346,
    killed: false,
  }) as unknown as ChildProcess;
  const kill = jest.fn(() => {
    setImmediate(() => {
      stdout.end();
      stderr.end();
      child.emit('close', null);
    });
    return true;
  });
  (child as ChildProcess & { kill: typeof kill }).kill = kill;
  mockedSpawn.mockImplementationOnce((() => child) as typeof spawn);
  return kill;
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

  it('keeps the search interface limited to path, name, and content', () => {
    const search = filesystemToolDefinitions().find((tool) => tool.name === 'search');
    expect(Object.keys(search?.inputSchema.properties ?? {}).sort()).toEqual([
      'content', 'namePattern', 'path',
    ]);
  });

  it('advertises the read_file batch request and regex contract', () => {
    const definition = filesystemToolDefinitions().find((tool) => tool.name === 'read_file');
    const paths = definition?.inputSchema.properties?.paths as Record<string, unknown>;
    const pattern = definition?.inputSchema.properties?.pattern as Record<string, unknown>;
    expect(paths).toMatchObject({ type: 'array', minItems: 1, maxItems: 25 });
    expect(definition?.inputSchema.required).toBeUndefined();
    expect(definition?.description).toMatch(/case-insensitive regular expression/i);
    expect(pattern.description).toMatch(/4096 characters/i);
    expect(pattern.description).toMatch(/exact value "\*" is reserved/i);
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

describe('Windows slash-drive path normalization', () => {
  it.each([
    ['/c/path/file.txt', String.raw`C:\path\file.txt`],
    ['/C/path/file.txt', String.raw`C:\path\file.txt`],
    ['/c', 'C:\\'],
    ['/c/', 'C:\\'],
  ])('normalizes %s on Windows', (input, expected) => {
    expect(_normalizeSlashDrivePathForTests(input, 'win32')).toBe(expected);
  });

  it.each([
    '/foo/bar',
    '//server/share/file.txt',
    String.raw`C:\already\native.txt`,
    'c/relative/path.txt',
    '/cc/not-a-drive.txt',
  ])('does not rewrite non-drive input %s', (input) => {
    expect(_normalizeSlashDrivePathForTests(input, 'win32')).toBe(input);
  });

  it('does not rewrite slash-drive paths on non-Windows platforms', () => {
    expect(_normalizeSlashDrivePathForTests('/c/path/file.txt', 'linux')).toBe('/c/path/file.txt');
  });

  it('leaves dot segments for the centralized resolver to canonicalize', () => {
    expect(_normalizeSlashDrivePathForTests('/c/one/../two.txt', 'win32'))
      .toBe(String.raw`C:\one\..\two.txt`);
  });
});

describe('filesystem operations', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-fs-'));
    mockedRoots.mockResolvedValue([dir]);
  });
  afterEach(async () => {
    _setRipgrepExecutableForTests(undefined);
    mockedSpawn.mockClear();
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

  it('uses slash-drive paths across the centralized resolver without widening roots', async () => {
    if (process.platform !== 'win32') return;

    const target = path.join(dir, 'slash-drive.txt');
    await fsp.writeFile(target, 'slash-drive content');
    const asSlashDrive = (nativePath: string): string => nativePath
      .replace(/^([A-Za-z]):/, (_whole, drive: string) => `/${drive.toLowerCase()}`)
      .replace(/\\/g, '/');
    const slashTarget = asSlashDrive(target);
    const slashRoot = asSlashDrive(dir);

    expect(parse(await filesystemCallTool('read_file', { path: slashTarget })).content)
      .toBe('slash-drive content');
    const batch = parse(await filesystemCallTool('read_file', { paths: [slashTarget, slashTarget] }));
    expect((batch.files as Array<Record<string, unknown>>).map((file) => file.path))
      .toEqual([target, target]);
    expect(parse(await filesystemCallTool('get_file_info', {
      path: `${slashRoot}/nested/../slash-drive.txt`,
    })).isFile).toBe(true);

    const escaped = await filesystemCallTool('get_file_info', {
      path: `${slashRoot}/../outside.txt`,
    });
    expect(escaped.isError).toBe(true);
    expect(text(escaped)).toMatch(/outside the configured filesystem roots/i);
  });

  it('reads a specific line range', async () => {
    const p = path.join(dir, 'b.txt');
    await filesystemCallTool('write_file', { path: p, content: 'a\nb\nc\nd\ne\n' });
    const out = parse(await filesystemCallTool('read_file', { path: p, from: 2, to: 3 }));
    expect(out.content).toBe('b\nc');
    expect(out.from).toBe(2);
    expect(out.to).toBe(3);
  });

  it('reads multiple files in order, preserves duplicates, and returns matching structured content', async () => {
    const first = path.join(dir, 'first.txt');
    const second = path.join(dir, 'second.txt');
    await fsp.writeFile(first, 'alpha\nneedle\nomega');
    await fsp.writeFile(second, 'one\nneedle\nthree');

    const result = await filesystemCallTool('read_file', {
      paths: [first, second, first],
      pattern: 'needle',
    });
    const payload = parse(result);
    const files = payload.files as Array<Record<string, unknown>>;

    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual(payload);
    expect(files.map((file) => file.path)).toEqual([first, second, first]);
    expect(files.every((file) => typeof file.contentHash === 'string')).toBe(true);
    expect(files.every((file) => (file.content as string).includes('needle'))).toBe(true);
  });

  it('keeps batch successes when individual files fail', async () => {
    const good = path.join(dir, 'good.txt');
    const missing = path.join(dir, 'missing.txt');
    await fsp.writeFile(good, 'ok');

    const payload = parse(await filesystemCallTool('read_file', { paths: [good, missing, dir] }));
    const files = payload.files as Array<Record<string, unknown>>;

    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ path: good, content: 'ok' });
    expect(files[1]).toMatchObject({ requestedPath: missing, path: missing });
    expect(files[1].error).toEqual(expect.any(String));
    expect(files[2]).toMatchObject({ requestedPath: dir, path: dir, error: 'Expected a regular file to read.' });
  });

  it.each([
    [{}, 'Provide "path".'],
    [{ path: 'one', paths: ['two'] }, 'Provide either "path" or "paths", not both.'],
    [{ paths: [] }, 'Provide a non-empty "paths" array.'],
    [{ paths: ['valid', 1] }, 'Every entry in "paths" must be a non-empty string.'],
    [{ paths: Array.from({ length: 26 }, (_, i) => String(i)) }, 'Provide at most 25 paths.'],
  ])('rejects invalid read target forms', async (args, message) => {
    const result = await filesystemCallTool('read_file', args);
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({ error: message });
    expect(structured(result)).toBeUndefined();
  });

  it.each([
    ['whole-file', {}],
    ['pattern', { pattern: 'needle' }],
    ['range', { from: 1, to: 2 }],
  ])('rejects a directory target for a %s read', async (_mode, options) => {
    const result = await filesystemCallTool('read_file', { path: dir, ...options });

    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({ error: 'Expected a regular file to read.' });
    expect(structured(result)).toBeUndefined();
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

  it('search uses Dirent traversal and the portable Node fallback when ripgrep is unavailable', async () => {
    _setRipgrepExecutableForTests(null);
    await fsp.mkdir(path.join(dir, 'nested'));
    await fsp.writeFile(path.join(dir, 'nested', 'fallback.txt'), 'alpha\nportable token\nomega');
    const lstat = jest.spyOn(fsp, 'lstat');
    try {
      const out = parse(await filesystemCallTool('search', {
        path: dir,
        namePattern: 'fallback',
        content: 'portable token',
      }));
      expect(out.matches).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('fallback.txt') }),
        expect.objectContaining({ path: expect.stringContaining('fallback.txt'), line: 2, text: 'portable token' }),
      ]));
      expect(lstat).not.toHaveBeenCalled();
      expect(mockedSpawn).not.toHaveBeenCalled();
    } finally {
      lstat.mockRestore();
    }
  });

  it('search uses ripgrep JSON as a transparent content fast path', async () => {
    const executable = process.platform === 'win32' ? 'C:\\tools\\rg.exe' : '/tools/rg';
    _setRipgrepExecutableForTests(executable);
    mockRipgrepMatches([{ path: 'nested/doc.txt', line: 7, text: 'Fast TOKEN result' }]);

    const out = parse(await filesystemCallTool('search', { path: dir, content: 'token' }));
    expect(out).toEqual({
      matches: [{ path: path.resolve(dir, 'nested/doc.txt'), line: 7, text: 'Fast TOKEN result' }],
      truncated: false,
    });
    expect(mockedSpawn).toHaveBeenCalledWith(
      executable,
      expect.arrayContaining(['--json', '--fixed-strings', '--ignore-case', '--hidden', '--no-ignore', 'token', '.']),
      expect.objectContaining({ cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('search enforces one global result budget in the Node fallback', async () => {
    _setRipgrepExecutableForTests(null);
    await Promise.all([
      fsp.writeFile(path.join(dir, 'many-a.txt'), Array.from({ length: 700 }, () => 'shared token').join('\n')),
      fsp.writeFile(path.join(dir, 'many-b.txt'), Array.from({ length: 700 }, () => 'shared token').join('\n')),
    ]);
    const out = parse(await filesystemCallTool('search', { path: dir, content: 'shared token' }));
    expect(out.matches).toHaveLength(1_000);
    expect(out.truncated).toBe(true);
  });

  it('search kills ripgrep when the MCP request is cancelled', async () => {
    _setRipgrepExecutableForTests(process.platform === 'win32' ? 'C:\\tools\\rg.exe' : '/tools/rg');
    const kill = mockHangingRipgrep();
    const controller = new AbortController();
    const pending = filesystemCallTool(
      'search',
      { path: dir, content: 'token' },
      undefined,
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(parse(result).error).toContain('cancelled');
    expect(kill).toHaveBeenCalled();
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

  it('keeps error results out of successful output schemas', async () => {
    const missing = path.join(dir, 'missing-directory');
    const r = await filesystemCallTool('list_dir', { path: missing });

    expect(r.isError).toBe(true);
    expect(structured(r)).toBeUndefined();
    expect(parse(r)).toEqual({
      error: expect.stringContaining('missing-directory'),
    });
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

  it('read_file: regex supports anchors, alternation, classes, quantifiers, and case-insensitivity', async () => {
    const p = path.join(dir, 'regex.txt');
    await fsp.writeFile(p, ['zero', 'Alpha12', 'item-AbC', 'alpha1', 'tail'].join('\n'));

    const out = parse(await filesystemCallTool('read_file', {
      path: p,
      pattern: '^(alpha\\d{2}|item-[a-c]{3})$',
    }));
    expect(out.matches).toEqual([
      { line: 2, text: 'Alpha12' },
      { line: 3, text: 'item-AbC' },
    ]);
    expect(typeof out.contentHash).toBe('string');
  });

  it('read_file: regex metacharacters are active and can be escaped for literal intent', async () => {
    const p = path.join(dir, 'regex-literal.txt');
    await fsp.writeFile(p, ['a.b', 'axb', 'other'].join('\n'));

    const wildcard = parse(await filesystemCallTool('read_file', { path: p, pattern: '^a.b$' }));
    expect((wildcard.matches as unknown[])).toHaveLength(2);
    const literal = parse(await filesystemCallTool('read_file', { path: p, pattern: '^a\\.b$' }));
    expect(literal.matches).toEqual([{ line: 1, text: 'a.b' }]);
  });

  it('read_file: regex preserves context, disjoint separators, no-match behavior, and match caps', async () => {
    const p = path.join(dir, 'regex-context.txt');
    const lines = Array.from({ length: 12 }, (_, i) => ([2, 9].includes(i) ? 'HIT' : `line ${i + 1}`));
    await fsp.writeFile(p, lines.join('\n'));

    const out = parse(await filesystemCallTool('read_file', { path: p, pattern: '^hit$' }));
    expect(out.matches).toEqual([{ line: 3, text: 'HIT' }, { line: 10, text: 'HIT' }]);
    expect(out.content as string).toContain('…');
    expect(out.content as string).toContain('1: line 1');
    expect(out.content as string).toContain('12: line 12');

    const none = parse(await filesystemCallTool('read_file', { path: p, pattern: '^absent$' }));
    expect(none.matches).toEqual([]);
    expect(none.content).toMatch(/no lines matched/i);

    const many = path.join(dir, 'regex-many.txt');
    await fsp.writeFile(many, Array.from({ length: 205 }, () => 'match').join('\n'));
    const capped = parse(await filesystemCallTool('read_file', { path: many, pattern: '^match$' }));
    expect(capped.matches).toHaveLength(200);
    expect(capped.truncated).toBe(true);
    expect((capped.content as string).length).toBeLessThanOrEqual(200_000);
  });

  it('read_file: invalid and over-limit regexes return bounded tool errors, including in batches', async () => {
    const first = path.join(dir, 'regex-error-a.txt');
    const second = path.join(dir, 'regex-error-b.txt');
    await Promise.all([fsp.writeFile(first, 'a'), fsp.writeFile(second, 'b')]);

    const invalid = await filesystemCallTool('read_file', { path: first, pattern: '[' });
    expect(invalid.isError).toBe(true);
    expect(parse(invalid).error).toMatch(/invalid regular expression/i);

    const overLimit = await filesystemCallTool('read_file', {
      path: first,
      pattern: 'a'.repeat(4_097),
    });
    expect(overLimit.isError).toBe(true);
    expect(parse(overLimit).error).toMatch(/4096-character limit/i);

    const batch = parse(await filesystemCallTool('read_file', {
      paths: [first, second],
      pattern: '[',
    }));
    expect(batch.files).toEqual([
      expect.objectContaining({ requestedPath: first, error: expect.stringMatching(/invalid regular expression/i) }),
      expect.objectContaining({ requestedPath: second, error: expect.stringMatching(/invalid regular expression/i) }),
    ]);
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
