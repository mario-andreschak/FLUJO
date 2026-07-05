/**
 * Tests for /api/browse — the backend directory listing behind the shared
 * FolderPickerDialog. Paths in FLUJO configs are consumed by the BACKEND
 * (which may run on a different machine than the browser), so pickers browse
 * here rather than via the browser's own file dialogs.
 */
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import type { NextRequest } from 'next/server';
import { GET } from '@/app/api/browse/route';

const call = (target?: string) => {
  const url = target
    ? `http://localhost:4200/api/browse?path=${encodeURIComponent(target)}`
    : 'http://localhost:4200/api/browse';
  return GET(new Request(url) as unknown as NextRequest);
};

describe('browse route', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browse-test-'));
    await fs.mkdir(path.join(dir, 'beta-folder'));
    await fs.mkdir(path.join(dir, 'Alpha-folder'));
    await fs.writeFile(path.join(dir, 'a-file.txt'), 'x');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists a directory with folders first, names case-insensitively sorted', async () => {
    const response = await call(dir);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.path).toBe(path.resolve(dir));
    expect(body.parent).toBe(path.dirname(path.resolve(dir)));
    expect(body.home).toBe(os.homedir());
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual([
      'Alpha-folder',
      'beta-folder',
      'a-file.txt',
    ]);
    expect(body.entries[0].isDirectory).toBe(true);
    expect(body.entries[2].isDirectory).toBe(false);
    expect(body.entries[2].path).toBe(path.join(path.resolve(dir), 'a-file.txt'));
  });

  it('defaults to the home directory without a path', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.path).toBe(os.homedir());
  });

  it('400s a nonexistent path and a file path with friendly messages', async () => {
    const missing = await call(path.join(dir, 'nope'));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/does not exist/);

    const file = await call(path.join(dir, 'a-file.txt'));
    expect(file.status).toBe(400);
    expect((await file.json()).error).toMatch(/not a folder/);
  });

  it('reports no parent at the filesystem top', async () => {
    const top = process.platform === 'win32' ? path.parse(dir).root : '/';
    const response = await call(top);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.parent).toBeNull();
  });

  it('lists drives on Windows', async () => {
    const response = await call(dir);
    const body = await response.json();
    if (process.platform === 'win32') {
      expect(body.drives.length).toBeGreaterThan(0);
      expect(body.drives[0]).toMatch(/^[A-Z]:\\$/);
    } else {
      expect(body.drives).toEqual([]);
    }
  });
});
