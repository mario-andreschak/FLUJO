import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('@/backend/services/mcp/config', () => ({ loadServerRoots: jest.fn() }));

import { loadServerRoots } from '@/backend/services/mcp/config';
import { filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';
import { _clearTouchedFilesForTests } from '@/backend/services/mcp/internal/filesystemResources';

const originalCeiling = process.env.FLUJO_FS_ROOTS;
const rootsMock = jest.mocked(loadServerRoots);
const posixIt = process.platform === 'win32' ? it.skip : it;
const modes: Array<[string, Record<string, unknown>]> = [
  ['overwrite', {}],
  ['append', { mode: 'append' }],
  ['insert', { mode: 'insert', startLine: 1 }],
  ['range overwrite', { startLine: 1, endLine: 1 }],
];

describe('filesystem creation permissions', () => {
  let parent: string;
  let root: string;
  let file: string;

  beforeEach(async () => {
    parent = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(parent, 'flujo-file-permissions-'));
    file = path.join(root, 'record.txt');
    process.env.FLUJO_FS_ROOTS = root;
    rootsMock.mockResolvedValue([root]);
    _clearTouchedFilesForTests();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    _clearTouchedFilesForTests();
    if (originalCeiling === undefined) delete process.env.FLUJO_FS_ROOTS;
    else process.env.FLUJO_FS_ROOTS = originalCeiling;
    const resolved = await fs.realpath(root);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('flujo-file-permissions-')) {
      throw new Error('Refusing cleanup outside the owned permission fixture.');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });

  it.each(modes)('preserves %s content when creating a file', async (_name, mode) => {
    const result = await filesystemCallTool('write_file', { path: file, content: 'private fixture', ...mode });
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('private fixture');
  });

  posixIt.each(modes)('creates %s files with mode 0600 even under umask 000', async (_name, mode) => {
    const oldUmask = process.umask(0);
    try {
      const result = await filesystemCallTool('write_file', { path: file, content: 'private fixture', ...mode });
      expect(result.isError).not.toBe(true);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(oldUmask);
    }
  });

  const operations: Array<[string, string, Record<string, unknown>]> = [
    ['overwrite', 'write_file', { content: 'changed' }],
    ['append', 'write_file', { content: 'changed', mode: 'append' }],
    ['insert', 'write_file', { content: 'changed', mode: 'insert', startLine: 2 }],
    ['range', 'write_file', { content: 'changed', startLine: 2, endLine: 2 }],
    ['literal edit', 'edit_file', { edits: [{ oldText: 'second', newText: 'changed' }] }],
    ['diff edit', 'edit_file', { diff: '@@ -1,2 +1,2 @@\n first\n-second\n+changed' }],
  ];

  posixIt.each(operations)('preserves an existing executable mode during %s', async (_name, tool, args) => {
    const target = await fs.open(file, 'wx', 0o755);
    try {
      await target.writeFile('first\nsecond\n', 'utf8');
      await target.chmod(0o755);
    } finally {
      await target.close();
    }
    const result = await filesystemCallTool(tool, { path: file, ...args });
    expect(result.isError).not.toBe(true);
    const observation = await fs.open(file, 'r');
    try {
      expect((await observation.stat()).mode & 0o777).toBe(0o755);
      expect(await observation.readFile('utf8')).toContain('changed');
    } finally {
      await observation.close();
    }
  });

  it.each(operations.filter(([, , args]) => 'edits' in args || 'diff' in args))('preserves BOM and CRLF during %s', async (_name, tool, args) => {
    await fs.writeFile(file, '\uFEFFfirst\r\nsecond\r\n', { mode: 0o600 });
    const result = await filesystemCallTool(tool, { path: file, ...args });
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('\uFEFFfirst\r\nchanged\r\n');
  });

  it.each(operations.filter(([, , args]) => 'edits' in args || 'diff' in args))('keeps stale expectedHash rejection for %s', async (_name, tool, args) => {
    await fs.writeFile(file, 'first\nsecond\n', { mode: 0o600 });
    const staleHash = createHash('sha256').update('old content').digest('hex');
    const result = await filesystemCallTool(tool, { path: file, expectedHash: staleHash, ...args });
    expect(result.isError).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('first\nsecond\n');
  });

  posixIt.each(operations.filter(([, , args]) => 'edits' in args || 'diff' in args))('privately recreates a file removed after the %s read', async (_name, tool, args) => {
    await fs.writeFile(file, 'first\nsecond\n', { mode: 0o755 });
    const readFile = fs.readFile.bind(fs);
    let removed = false;
    jest.spyOn(fs, 'readFile').mockImplementation(async (...readArgs: Parameters<typeof fs.readFile>) => {
      const value = await readFile(...readArgs);
      if (readArgs[0] === file && !removed) {
        removed = true;
        await fs.unlink(file);
      }
      return value;
    });
    const oldUmask = process.umask(0);
    try {
      const result = await filesystemCallTool(tool, { path: file, ...args });
      expect(result.isError).not.toBe(true);
      expect(removed).toBe(true);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, 'utf8')).toContain('changed');
    } finally {
      process.umask(oldUmask);
    }
  });
});
