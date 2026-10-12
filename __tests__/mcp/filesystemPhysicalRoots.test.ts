import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

jest.mock('@/backend/services/mcp/config', () => ({ loadServerRoots: jest.fn() }));

import { loadServerRoots } from '@/backend/services/mcp/config';
import { filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';
import {
  _clearTouchedFilesForTests, filesystemListResources, readTouchedFileResource,
} from '@/backend/services/mcp/internal/filesystemResources';

const originalCeiling = process.env.FLUJO_FS_ROOTS;
const mockedRoots = loadServerRoots as jest.Mock;
const content = (result: CallToolResult) => JSON.stringify(result.content);

describe('filesystem physical roots', () => {
  let parent: string;
  let fixture: string;
  let allowed: string;
  let outside: string;
  let link: string;
  let links: string[];

  async function directoryLink(target: string, destination: string) {
    await fs.symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(destination);
  }

  beforeEach(async () => {
    parent = await fs.realpath(os.tmpdir());
    fixture = await fs.mkdtemp(path.join(parent, 'flujo-physical-roots-'));
    allowed = path.join(fixture, 'allowed');
    outside = path.join(fixture, 'outside');
    link = path.join(allowed, 'link');
    links = [];
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'marker.txt'), 'outside synthetic marker');
    await fs.writeFile(path.join(allowed, 'inside.txt'), 'inside synthetic marker');
    await directoryLink(outside, link);
    process.env.FLUJO_FS_ROOTS = allowed;
    mockedRoots.mockResolvedValue([allowed]);
    _clearTouchedFilesForTests();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    _clearTouchedFilesForTests();
    if (originalCeiling === undefined) delete process.env.FLUJO_FS_ROOTS;
    else process.env.FLUJO_FS_ROOTS = originalCeiling;
    for (const entry of links) {
      await fs.unlink(entry).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const resolved = await fs.realpath(fixture);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('flujo-physical-roots-')) {
      throw new Error('Refusing cleanup outside the owned fixture.');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });

  const blockedOperations: Array<[string, string, (target: string, inside: string) => Record<string, unknown>]> = [
    ['read', 'read_file', target => ({ path: target, pattern: '*' })],
    ['write', 'write_file', target => ({ path: target, content: 'changed' })],
    ['append', 'write_file', target => ({ path: target, content: 'changed', mode: 'append' })],
    ['insert', 'write_file', target => ({ path: target, content: 'changed', mode: 'insert', startLine: 1 })],
    ['range', 'write_file', target => ({ path: target, content: 'changed', startLine: 1, endLine: 1 })],
    ['literal edit', 'edit_file', target => ({ path: target, edits: [{ oldText: 'outside', newText: 'changed' }] })],
    ['diff edit', 'edit_file', target => ({ path: target, diff: '@@ -1 +1 @@\n-outside synthetic marker\n+changed' })],
    ['metadata', 'get_file_info', target => ({ path: target })],
    ['delete', 'delete', target => ({ path: target })],
    ['move source', 'move', (target, inside) => ({ source: target, destination: inside })],
    ['move destination', 'move', (target, inside) => ({ source: inside, destination: target })],
    ['list', 'list_dir', target => ({ path: path.dirname(target) })],
    ['tree', 'dir_tree', target => ({ path: path.dirname(target) })],
    ['search', 'search', target => ({ path: path.dirname(target), content: 'marker' })],
    ['mkdir', 'create_directory', target => ({ path: path.join(path.dirname(target), 'new-directory') })],
  ];

  it.each(blockedOperations)('rejects an outside destination through a junction: %s', async (_label, tool, args) => {
    const operations = [
      jest.spyOn(fs, 'open'), jest.spyOn(fs, 'readFile'), jest.spyOn(fs, 'writeFile'),
      jest.spyOn(fs, 'mkdir'), jest.spyOn(fs, 'rename'), jest.spyOn(fs, 'rm'),
      jest.spyOn(fs, 'readdir'), jest.spyOn(fs, 'stat'),
    ];
    const result = await filesystemCallTool(tool, args(path.join(link, 'marker.txt'), path.join(allowed, 'inside.txt')));
    const calls = operations.map(operation => operation.mock.calls.length);
    operations.forEach(operation => operation.mockRestore());
    expect(calls).toEqual(operations.map(() => 0));
    expect(result.isError).toBe(true);
    expect(content(result)).toMatch(/outside the configured filesystem roots/);
    expect(content(result)).not.toContain('outside synthetic marker');
    expect(await fs.readFile(path.join(outside, 'marker.txt'), 'utf8')).toBe('outside synthetic marker');
    expect(await fs.readFile(path.join(allowed, 'inside.txt'), 'utf8')).toBe('inside synthetic marker');
  });

  it('rejects creation through an escaping parent before creating missing directories', async () => {
    const result = await filesystemCallTool('write_file', {
      path: path.join(link, 'missing', 'new.txt'), content: 'changed',
    });
    expect(result.isError).toBe(true);
    await expect(fs.lstat(path.join(outside, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not let a client root junction widen the environment ceiling', async () => {
    mockedRoots.mockResolvedValue([link]);
    const result = await filesystemCallTool('read_file', { path: path.join(link, 'marker.txt'), pattern: '*' });
    expect(result.isError).toBe(true);
    expect(content(result)).toMatch(/outside the configured filesystem roots/);
  });

  it('allows a link into another explicitly allowed root', async () => {
    process.env.FLUJO_FS_ROOTS = [allowed, outside].join(path.delimiter);
    mockedRoots.mockResolvedValue([allowed, outside]);
    const result = await filesystemCallTool('read_file', { path: path.join(link, 'marker.txt'), pattern: '*' });
    expect(result.isError).toBeUndefined();
    expect(content(result)).toContain('outside synthetic marker');
  });

  it('allows a configured root that itself is a junction', async () => {
    process.env.FLUJO_FS_ROOTS = link;
    mockedRoots.mockResolvedValue([link]);
    const result = await filesystemCallTool('read_file', { path: path.join(link, 'marker.txt'), pattern: '*' });
    expect(result.isError).toBeUndefined();
    expect(content(result)).toContain('outside synthetic marker');
  });

  it('keeps move/delete semantics for a link whose target is allowed', async () => {
    const target = path.join(allowed, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'kept.txt'), 'keep');
    const localLink = path.join(allowed, 'local-link');
    await directoryLink(target, localLink);
    const moved = path.join(allowed, 'moved-link');
    const result = await filesystemCallTool('move', { source: localLink, destination: moved });
    expect(result.isError).toBeUndefined();
    links.push(moved);
    expect((await fs.lstat(moved)).isSymbolicLink()).toBe(true);
    expect((await filesystemCallTool('delete', { path: moved, recursive: true })).isError).toBeUndefined();
    expect(await fs.readFile(path.join(target, 'kept.txt'), 'utf8')).toBe('keep');
  });

  it('allows ordinary missing roots and nested file creation', async () => {
    const newRoot = path.join(fixture, 'new-root');
    process.env.FLUJO_FS_ROOTS = newRoot;
    mockedRoots.mockResolvedValue([newRoot]);
    const file = path.join(newRoot, 'nested', 'created.txt');
    expect((await filesystemCallTool('write_file', { path: file, content: 'created' })).isError).toBeUndefined();
    expect(await fs.readFile(file, 'utf8')).toBe('created');
  });

  it('rejects a dangling link instead of treating it as a missing directory', async () => {
    const dangling = path.join(allowed, 'dangling');
    await directoryLink(path.join(outside, 'absent'), dangling);
    const result = await filesystemCallTool('write_file', { path: path.join(dangling, 'new.txt'), content: 'changed' });
    expect(result.isError).toBe(true);
    expect(content(result)).toMatch(/outside the configured filesystem roots/);
    await expect(fs.lstat(path.join(outside, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not follow listing links just to disclose their target size', async () => {
    const stat = jest.spyOn(fs, 'stat');
    const result = await filesystemCallTool('list_dir', { path: allowed });
    expect(result.isError).toBeUndefined();
    expect(stat.mock.calls.some(([file]) => file === link)).toBe(false);
  });

  it('rechecks physical roots when a tracked file parent becomes a junction', async () => {
    const tracked = path.join(allowed, 'tracked');
    await fs.mkdir(tracked);
    const file = path.join(tracked, 'marker.txt');
    await fs.writeFile(file, 'initial inside marker');
    expect((await filesystemCallTool('read_file', { path: file })).isError).toBeUndefined();
    const resource = filesystemListResources().resources.find(entry => entry.name === 'marker.txt');
    expect(resource).toBeDefined();
    await fs.rename(tracked, path.join(allowed, 'original'));
    await directoryLink(outside, tracked);
    const result = await readTouchedFileResource(resource!.uri);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(JSON.stringify(result)).not.toContain('outside synthetic marker');
    expect((await filesystemCallTool('read_file', { path: file })).isError).toBe(true);
  });
});
