/**
 * Enforcement tests for the optional protected-path deny layer (issue #260):
 * configured roots win by default, while opting into the experimental layer
 * makes it fire even when the allow-list WOULD permit the path.
 *
 * `getHomeDir()` is mocked to a real temp dir that also acts as the configured
 * root, so an unprotected subpath is allowed while a protected subpath (e.g.
 * Documents / AppData / .ssh) is blocked with the protection message.
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));

jest.mock('@/utils/paths', () => {
  const actual = jest.requireActual('@/utils/paths');
  return { ...actual, getHomeDir: jest.fn() };
});

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerRoots: jest.fn(),
}));

// `filesystemResources.ts` (pulled in via filesystemTools) imports the ESM-only
// `@modelcontextprotocol/ext-apps` package, which Jest cannot transpile. Mock
// the single constant it needs (same approach as filesystemTools.test.ts).
jest.mock('@modelcontextprotocol/ext-apps', () => ({
  LATEST_PROTOCOL_VERSION: '2026-01-26',
}));

import { getHomeDir } from '@/utils/paths';
import { loadServerRoots } from '@/backend/services/mcp/config';
import { filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';
import {
  bashCallTool,
  _resetBashSessionsForTests,
  _resetBashShellCacheForTests,
} from '@/backend/services/mcp/internal/bashTools';
import { __resetProtectedPathsCache } from '@/backend/services/mcp/internal/protectedPaths';

const mockedHome = getHomeDir as jest.Mock;
const mockedRoots = loadServerRoots as jest.Mock;

function text(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}
function parse(r: CallToolResult): Record<string, unknown> {
  return JSON.parse(text(r));
}

// The protected subdir to probe per platform (all are on the denylist).
const PROTECTED_SUBDIR = process.platform === 'win32' ? 'AppData' : 'Documents';

describe('protected-path enforcement in built-in filesystem/bash servers', () => {
  let home: string;

  beforeEach(async () => {
    // Create the fake home under the REAL home dir, NOT under os.tmpdir() or the
    // FLUJO data dir, since both are exempt from the deny layer.
    home = await fsp.mkdtemp(path.join(os.homedir(), 'flujo-home-'));
    await fsp.mkdir(path.join(home, PROTECTED_SUBDIR), { recursive: true });
    await fsp.mkdir(path.join(home, 'work'), { recursive: true });
    mockedHome.mockReturnValue(home);
    // Simulate the operator mistake: configure the whole home as a root, so the
    // allow-list alone WOULD permit the protected subpaths.
    mockedRoots.mockResolvedValue([home]);
    loadItemMock.mockResolvedValue({
      experimental: { protectedPathsEnabled: true },
    });
    __resetProtectedPathsCache();
  });
  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
    mockedRoots.mockReset();
    loadItemMock.mockReset();
    _resetBashSessionsForTests();
    _resetBashShellCacheForTests();
    __resetProtectedPathsCache();
  });

  it('allows an unprotected subpath of the configured root', async () => {
    const r = await filesystemCallTool('write_file', { path: path.join(home, 'work', 'ok.txt'), content: 'x' });
    expect(r.isError).toBeUndefined();
  });

  it('lets configured roots access protected locations by default', async () => {
    loadItemMock.mockResolvedValue({ speech: { enabled: true } });
    const protectedDir = path.join(home, PROTECTED_SUBDIR);
    const target = path.join(protectedDir, 'allowed-by-root.txt');

    const w = await filesystemCallTool('write_file', { path: target, content: 'x' });
    expect(w.isError).toBeUndefined();

    const ls = await filesystemCallTool('list_dir', { path: protectedDir });
    expect(ls.isError).toBeUndefined();

    const bash = await bashCallTool('run', { command: 'echo hi', cwd: protectedDir });
    expect(bash.isError).toBeUndefined();
  });

  it('blocks read/write/list when the experimental protection is enabled', async () => {
    const target = path.join(home, PROTECTED_SUBDIR, 'secret.txt');
    const w = await filesystemCallTool('write_file', { path: target, content: 'x' });
    expect(w.isError).toBe(true);
    expect(text(w)).toMatch(/protected location/i);

    const rd = await filesystemCallTool('read_file', { path: target });
    expect(rd.isError).toBe(true);
    expect(text(rd)).toMatch(/protected location/i);

    const ls = await filesystemCallTool('list_dir', { path: path.join(home, PROTECTED_SUBDIR) });
    expect(ls.isError).toBe(true);
    expect(text(ls)).toMatch(/protected location/i);
  });

  it('blocks move when protection is enabled and either endpoint is protected', async () => {
    await fsp.writeFile(path.join(home, 'work', 'src.txt'), 'x');
    const toProtected = await filesystemCallTool('move', {
      source: path.join(home, 'work', 'src.txt'),
      destination: path.join(home, PROTECTED_SUBDIR, 'moved.txt'),
    });
    expect(toProtected.isError).toBe(true);
    expect(text(toProtected)).toMatch(/protected location/i);

    const fromProtected = await filesystemCallTool('move', {
      source: path.join(home, PROTECTED_SUBDIR, 'x.txt'),
      destination: path.join(home, 'work', 'dst.txt'),
    });
    expect(fromProtected.isError).toBe(true);
    expect(text(fromProtected)).toMatch(/protected location/i);
  });

  it('blocks bash cwd inside a protected path when protection is enabled', async () => {
    const r = await bashCallTool('run', { command: 'echo hi', cwd: path.join(home, PROTECTED_SUBDIR) });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/protected location/i);
  });

  it('attaches advisory warnings for a command referencing a protected path but still runs', async () => {
    const protectedPath = path.join(home, PROTECTED_SUBDIR, 'file.txt');
    const cmd = process.platform === 'win32' ? `echo hi "${protectedPath}"` : `echo hi ${protectedPath}`;
    const r = await bashCallTool('run', { command: cmd, cwd: path.join(home, 'work') });
    expect(r.isError).toBeUndefined();
    const out = parse(r);
    expect(out.exitCode).toBe(0);
    expect(Array.isArray(out.warnings)).toBe(true);
    expect((out.warnings as string[]).join(' ')).toMatch(/protected location/i);
  });
});
