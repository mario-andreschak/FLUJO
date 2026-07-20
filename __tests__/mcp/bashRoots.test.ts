/**
 * Tests for the built-in `bash` server's confinement + env hygiene (issue #175):
 *  - the `cwd` is confined to the same effective-roots model as `filesystem`
 *    (persisted roots + a FLUJO_BASH_ROOTS / FLUJO_FS_ROOTS hard ceiling), and
 *  - spawned commands DO NOT inherit the full backend process.env by default;
 *    a documented opt-in (FLUJO_BASH_INHERIT_ENV) restores it.
 *
 * The registry (storage-backed) is mocked so the effective-roots merge can be
 * exercised without a real storage layer.
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

jest.mock('@/backend/services/mcp/internal/registry', () => ({
  BASH_SERVER_NAME: 'bash',
  getInternalServerRoots: jest.fn(),
}));

import { getInternalServerRoots } from '@/backend/services/mcp/internal/registry';
import { bashCallTool, _resetBashSessionsForTests } from '@/backend/services/mcp/internal/bashTools';

const mockedRoots = getInternalServerRoots as jest.Mock;

function text(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}

/** A command that echoes the seeded secret env var, cross-platform. */
const ECHO_SECRET = process.platform === 'win32' ? 'echo %FAKE_SECRET%' : 'echo "$FAKE_SECRET"';
const SECRET = 'super-secret-value-abc123';

describe('bash cwd confinement (issue #175)', () => {
  let dir: string;
  const prevFsEnv = process.env.FLUJO_FS_ROOTS;
  const prevBashEnv = process.env.FLUJO_BASH_ROOTS;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-bashroots-'));
    delete process.env.FLUJO_FS_ROOTS;
    delete process.env.FLUJO_BASH_ROOTS;
    mockedRoots.mockReset();
  });
  afterEach(async () => {
    _resetBashSessionsForTests();
    await fsp.rm(dir, { recursive: true, force: true });
    if (prevFsEnv === undefined) delete process.env.FLUJO_FS_ROOTS; else process.env.FLUJO_FS_ROOTS = prevFsEnv;
    if (prevBashEnv === undefined) delete process.env.FLUJO_BASH_ROOTS; else process.env.FLUJO_BASH_ROOTS = prevBashEnv;
  });

  it('allows a cwd inside the persisted roots and rejects one outside', async () => {
    mockedRoots.mockResolvedValue([dir]);

    const inside = await bashCallTool('run', { command: 'echo confinement-ok', cwd: dir });
    expect(inside.isError).toBeUndefined();

    const outside = os.tmpdir();
    const r = await bashCallTool('run', { command: 'echo nope', cwd: outside });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/outside/i);
  });

  it('rejects an outside cwd on the background `start` tool too', async () => {
    mockedRoots.mockResolvedValue([dir]);
    const r = await bashCallTool('start', { command: 'echo nope', cwd: os.tmpdir() });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/outside/i);
  });

  it('is unconfined when neither env nor persisted roots are set', async () => {
    mockedRoots.mockResolvedValue([]);
    const r = await bashCallTool('run', { command: 'echo free', cwd: os.tmpdir() });
    expect(r.isError).toBeUndefined();
  });

  it('keeps FLUJO_BASH_ROOTS as a hard ceiling over persisted roots', async () => {
    process.env.FLUJO_BASH_ROOTS = dir;
    const otherRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-bashother-'));
    try {
      mockedRoots.mockResolvedValue([otherRoot]);
      const escape = await bashCallTool('run', { command: 'echo escape', cwd: otherRoot });
      expect(escape.isError).toBe(true);
      expect(text(escape)).toMatch(/outside/i);

      const inside = await bashCallTool('run', { command: 'echo confinement-ok', cwd: dir });
      expect(inside.isError).toBeUndefined();
    } finally {
      await fsp.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('honors FLUJO_FS_ROOTS as the ceiling when FLUJO_BASH_ROOTS is unset (closes the bypass)', async () => {
    process.env.FLUJO_FS_ROOTS = dir;
    mockedRoots.mockResolvedValue([]);
    const r = await bashCallTool('run', { command: 'echo nope', cwd: os.tmpdir() });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/outside/i);
  });
});

describe('bash env scrubbing (issue #175)', () => {
  const prevSecret = process.env.FAKE_SECRET;
  const prevInherit = process.env.FLUJO_BASH_INHERIT_ENV;

  beforeEach(() => {
    mockedRoots.mockReset();
    mockedRoots.mockResolvedValue([]); // unconfined so cwd never blocks these
    process.env.FAKE_SECRET = SECRET;
    delete process.env.FLUJO_BASH_INHERIT_ENV;
  });
  afterEach(() => {
    _resetBashSessionsForTests();
    if (prevSecret === undefined) delete process.env.FAKE_SECRET; else process.env.FAKE_SECRET = prevSecret;
    if (prevInherit === undefined) delete process.env.FLUJO_BASH_INHERIT_ENV; else process.env.FLUJO_BASH_INHERIT_ENV = prevInherit;
  });

  it('does NOT leak a secret env var to spawned commands by default', async () => {
    const r = await bashCallTool('run', { command: ECHO_SECRET });
    const payload = JSON.parse(text(r)) as { output?: string };
    expect(payload.output ?? '').not.toContain(SECRET);
  });

  it('restores full env inheritance when FLUJO_BASH_INHERIT_ENV is set', async () => {
    process.env.FLUJO_BASH_INHERIT_ENV = '1';
    const r = await bashCallTool('run', { command: ECHO_SECRET });
    const payload = JSON.parse(text(r)) as { output?: string };
    expect(payload.output ?? '').toContain(SECRET);
  });
});
