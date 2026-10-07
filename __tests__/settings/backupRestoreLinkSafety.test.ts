import { constants, openSync, closeSync, promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  addFolderToZipLinkSafe,
  atomicWriteWithoutLinks,
  restoreFolderFromZipLinkSafe,
} from '@/backend/services/workspace/backupRestoreFs';

describe('MCP backup/restore link safety', () => {
  let fixtureRoot: string;
  let workspaceRoot: string;
  let mcpRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-backup-links-'));
    workspaceRoot = path.join(fixtureRoot, 'workspace');
    mcpRoot = path.join(workspaceRoot, 'mcp-servers');
    outsideRoot = path.join(fixtureRoot, 'outside');
    await fs.mkdir(mcpRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it('backs up regular files but skips junctions and hard links to outside data', async () => {
    await fs.writeFile(path.join(mcpRoot, 'server.json'), 'inside');
    const outsideSecret = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(outsideSecret, 'outside-secret');
    await fs.link(outsideSecret, path.join(mcpRoot, 'hardlink-secret.txt'));
    await fs.symlink(outsideRoot, path.join(mcpRoot, 'junction'), 'junction');

    const skipped: string[] = [];
    const zip = new JSZip();
    await addFolderToZipLinkSafe(
      zip,
      mcpRoot,
      'mcp-servers',
      workspaceRoot,
      entry => skipped.push(entry),
    );

    expect(await zip.file('mcp-servers/server.json')!.async('string')).toBe('inside');
    expect(zip.file('mcp-servers/hardlink-secret.txt')).toBeNull();
    expect(zip.file('mcp-servers/junction/secret.txt')).toBeNull();
    expect(skipped).toEqual(expect.arrayContaining([
      'mcp-servers/hardlink-secret.txt',
      'mcp-servers/junction',
    ]));
  });

  it('refuses to back up when the MCP root itself is a junction', async () => {
    const linkedRoot = path.join(workspaceRoot, 'linked-mcp');
    await fs.writeFile(path.join(outsideRoot, 'secret.txt'), 'outside-secret');
    await fs.symlink(outsideRoot, linkedRoot, 'junction');

    await expect(addFolderToZipLinkSafe(
      new JSZip(),
      linkedRoot,
      'mcp-servers',
      workspaceRoot,
    )).rejects.toThrow(/real directory/i);
  });

  it('rejects an admitted file replaced by a non-regular entry before open without reading it', async () => {
    const file = path.join(mcpRoot, 'replaced.json');
    await fs.writeFile(file, 'admitted fixture');
    const open = fs.open.bind(fs);
    let replaced = false;
    let watchdogReleased = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let read: jest.SpyInstance | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === file) {
        expect(args[1]).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        await fs.unlink(file);
        if (process.platform === 'win32') await fs.mkdir(file);
        else {
          execFileSync('mkfifo', [file], { timeout: 1000, windowsHide: true });
          // Release a blocking predecessor so regression failure cannot strand
          // libuv's open. A correct nonblocking read never needs this writer.
          watchdog = setTimeout(() => {
            watchdogReleased = true;
            try { closeSync(openSync(file, constants.O_WRONLY | constants.O_NONBLOCK)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error; }
          }, 750);
        }
        replaced = true;
      }
      const handle = await open(...args);
      if (String(args[0]) === file) read = jest.spyOn(handle, 'read');
      return handle;
    });
    const skipped: string[] = [];
    const zip = new JSZip();
    try {
      await addFolderToZipLinkSafe(zip, mcpRoot, 'mcp-servers', workspaceRoot, entry => skipped.push(entry));
    } finally { clearTimeout(watchdog); }
    expect(replaced).toBe(true);
    expect(watchdogReleased).toBe(false);
    expect(zip.file('mcp-servers/replaced.json')).toBeNull();
    expect(skipped).toContain('mcp-servers/replaced.json');
    if (read) expect(read).not.toHaveBeenCalled();
  });

  it('skips a file whose checked/opened inode values collide as Numbers', async () => {
    const file = path.join(mcpRoot, 'server.json');
    await fs.writeFile(file, 'inside');
    const colliding = BigInt('9007199254740992');
    expect(Number(colliding)).toBe(Number(colliding + BigInt(1)));
    const lstat = fs.lstat.bind(fs);
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const value = await lstat(...args);
      if (String(args[0]) === file) {
        expect(args[1]).toEqual({ bigint: true });
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: colliding });
      }
      return value;
    });
    const open = fs.open.bind(fs);
    let read: jest.SpyInstance | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === file) {
        const actual = await handle.stat({ bigint: true });
        jest.spyOn(handle, 'stat').mockResolvedValue(Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, { ino: colliding + BigInt(1) }));
        read = jest.spyOn(handle, 'read');
      }
      return handle;
    });
    const zip = new JSZip();
    await addFolderToZipLinkSafe(zip, mcpRoot, 'mcp-servers', workspaceRoot);
    expect(zip.file('mcp-servers/server.json')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves a restore candidate with an unowned exact inode hidden by Number rounding', async () => {
    const target = path.join(mcpRoot, 'server.json');
    const colliding = BigInt('9007199254740992');
    const open = fs.open.bind(fs);
    let temporary = '';
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes('.flujo-restore-')) {
        temporary = String(args[0]);
        const stat = handle.stat.bind(handle);
        jest.spyOn(handle, 'stat').mockImplementation(async () => {
          const value = await stat({ bigint: true });
          return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: colliding });
        });
      }
      return handle;
    });
    const lstat = fs.lstat.bind(fs);
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const value = await lstat(...args);
      if (String(args[0]) === temporary) {
        expect(args[1]).toEqual({ bigint: true });
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: colliding + BigInt(1) });
      }
      return value;
    });
    await expect(atomicWriteWithoutLinks(workspaceRoot, target, Buffer.from('intended'))).rejects.toThrow('temporary file changed');
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(temporary, 'utf8')).toBe('intended');
  });

  it('does not restore through an existing junction ancestor', async () => {
    await fs.symlink(outsideRoot, path.join(mcpRoot, 'escaped'), 'junction');
    const zip = new JSZip();
    zip.file('mcp-servers/escaped/pwned.txt', 'owned');
    const skipped: string[] = [];

    await restoreFolderFromZipLinkSafe(
      zip,
      'mcp-servers',
      mcpRoot,
      workspaceRoot,
      entry => skipped.push(entry),
    );

    await expect(fs.access(path.join(outsideRoot, 'pwned.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(skipped).toContain('mcp-servers/escaped/pwned.txt');
  });

  it('atomically replaces a hard-linked target without modifying its outside inode', async () => {
    const outsideVictim = path.join(outsideRoot, 'victim.txt');
    const destination = path.join(mcpRoot, 'server.txt');
    await fs.writeFile(outsideVictim, 'keep-me');
    await fs.link(outsideVictim, destination);
    const zip = new JSZip();
    zip.file('mcp-servers/server.txt', 'restored');

    await restoreFolderFromZipLinkSafe(
      zip,
      'mcp-servers',
      mcpRoot,
      workspaceRoot,
    );

    expect(await fs.readFile(outsideVictim, 'utf8')).toBe('keep-me');
    expect(await fs.readFile(destination, 'utf8')).toBe('restored');
  });

  it('refuses restore when the MCP target root is a junction', async () => {
    const linkedRoot = path.join(workspaceRoot, 'linked-mcp');
    await fs.symlink(outsideRoot, linkedRoot, 'junction');
    const zip = new JSZip();
    zip.file('mcp-servers/pwned.txt', 'owned');

    await expect(restoreFolderFromZipLinkSafe(
      zip,
      'mcp-servers',
      linkedRoot,
      workspaceRoot,
    )).rejects.toThrow(/real directory/i);
    await expect(fs.access(path.join(outsideRoot, 'pwned.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
