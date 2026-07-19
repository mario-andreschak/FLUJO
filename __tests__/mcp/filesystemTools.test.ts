/**
 * Tests for the built-in `filesystem` MCP server (issue #170): round-trip
 * read/write, line-range read, diff editing, dir listing + depth-limited tree,
 * search by name/content, create/move/delete, and FLUJO_FS_ROOTS confinement.
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { filesystemToolDefinitions, filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';

function text(r: CallToolResult): string {
  const first = r.content[0] as { text: string };
  return first.text;
}
function parse(r: CallToolResult): Record<string, unknown> {
  return JSON.parse(text(r));
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
});

describe('filesystem operations', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-fs-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
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
