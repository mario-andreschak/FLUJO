import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  addFolderToZipLinkSafe,
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
