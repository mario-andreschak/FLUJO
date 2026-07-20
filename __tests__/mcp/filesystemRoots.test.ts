/**
 * Tests for the built-in `filesystem` server's PERSISTED roots confinement
 * (issue #170): user-configured roots (stored via the MCP manager override) must
 * confine every path, and the FLUJO_FS_ROOTS env stays a hard ceiling on top.
 *
 * The registry (storage-backed) is mocked so the effective-roots merge can be
 * exercised without a real storage layer.
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

jest.mock('@/backend/services/mcp/internal/registry', () => ({
  FILESYSTEM_SERVER_NAME: 'filesystem',
  getInternalServerRoots: jest.fn(),
}));

import { getInternalServerRoots } from '@/backend/services/mcp/internal/registry';
import { filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';

const mockedRoots = getInternalServerRoots as jest.Mock;

function text(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}

describe('filesystem persisted roots confinement', () => {
  let dir: string;
  const prevEnv = process.env.FLUJO_FS_ROOTS;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-roots-'));
    delete process.env.FLUJO_FS_ROOTS;
    mockedRoots.mockReset();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.FLUJO_FS_ROOTS;
    else process.env.FLUJO_FS_ROOTS = prevEnv;
  });

  it('confines paths to the persisted roots when no env is set', async () => {
    mockedRoots.mockResolvedValue([dir]);
    const inside = await filesystemCallTool('write_file', { path: path.join(dir, 'ok.txt'), content: 'x' });
    expect(inside.isError).toBeUndefined();

    const outside = path.join(os.tmpdir(), `flujo-roots-outside-${Date.now()}.txt`);
    const r = await filesystemCallTool('write_file', { path: outside, content: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/outside/i);
  });

  it('is unconfined when neither env nor persisted roots are set', async () => {
    mockedRoots.mockResolvedValue([]);
    const outside = path.join(os.tmpdir(), `flujo-roots-free-${Date.now()}.txt`);
    const r = await filesystemCallTool('write_file', { path: outside, content: 'x' });
    expect(r.isError).toBeUndefined();
    await fsp.rm(outside, { force: true });
  });

  it('keeps the FLUJO_FS_ROOTS env as a hard ceiling over persisted roots', async () => {
    // Env ceiling is `dir`; a persisted root OUTSIDE it must not widen access.
    process.env.FLUJO_FS_ROOTS = dir;
    const otherRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-other-'));
    try {
      mockedRoots.mockResolvedValue([otherRoot]);
      const escape = await filesystemCallTool('write_file', { path: path.join(otherRoot, 'e.txt'), content: 'x' });
      expect(escape.isError).toBe(true);
      expect(text(escape)).toMatch(/outside/i);
      // Inside the env ceiling is still allowed.
      const inside = await filesystemCallTool('write_file', { path: path.join(dir, 'in.txt'), content: 'x' });
      expect(inside.isError).toBeUndefined();
    } finally {
      await fsp.rm(otherRoot, { recursive: true, force: true });
    }
  });
});
