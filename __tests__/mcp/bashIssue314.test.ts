/**
 * Regression suite for issue #314 ("Internal Bash MCP") — the seven failing
 * calls collected on a German-locale Windows machine without PowerShell 7,
 * without `rg`/`head`, and with only the WSL `bash.exe` relay.
 *
 * Each report is pinned here so the three remaining root causes cannot come back:
 *  A) an explicitly requested shell silently downgraded to another dialect
 *     (`shellFallback: {requestedShell: "pwsh", usedShell: "default"}`),
 *  B) missing third-party binaries surfacing only as a localized shell message,
 *  C) the System32 WSL launcher being selected as "bash".
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

import { loadServerRoots } from '@/backend/services/mcp/config';
import {
  bashCallTool,
  detectDialectMismatch,
  _resetBashSessionsForTests,
  _resetBashShellCacheForTests,
} from '@/backend/services/mcp/internal/bashTools';

const mockedRoots = loadServerRoots as jest.Mock;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;
const isWin = process.platform === 'win32';

function parse(r: CallToolResult): Record<string, unknown> {
  return JSON.parse((r.content[0] as { text: string }).text);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Replace the next spawn with a child that immediately succeeds. */
function mockCompletedChild(output = 'ok'): void {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: new PassThrough(),
    pid: 4242,
    killed: false,
  }) as unknown as ChildProcess;
  mockedSpawn.mockImplementationOnce((() => {
    setImmediate(() => {
      stdout.end(output);
      stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as typeof spawn);
}

const SHELL_ENV_VARS = [
  'PATH', 'Path', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData',
  'SystemRoot', 'windir', 'ComSpec', 'SHELL',
];

/** Run `body` with every shell-resolution env var replaced by `overrides`. */
async function withShellEnv(
  overrides: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = new Map(SHELL_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of SHELL_ENV_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[name] = value;
  }
  _resetBashShellCacheForTests();
  try {
    await body();
  } finally {
    for (const [name, value] of saved) restoreEnv(name, value);
    _resetBashShellCacheForTests();
  }
}

/** No interpreter of any kind can be resolved. */
async function withNoShells(body: () => Promise<void>): Promise<void> {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-314-empty-'));
  try {
    await withShellEnv({ PATH: empty, Path: empty, PATHEXT: '.EXE' }, body);
  } finally {
    await fsp.rm(empty, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  const { getDataDir } = await import('@/utils/paths');
  mockedRoots.mockResolvedValue([getDataDir()]);
});

afterEach(() => {
  _resetBashSessionsForTests();
  _resetBashShellCacheForTests();
  mockedSpawn.mockClear();
  mockedRoots.mockReset();
});

describe('issue #314 — an explicit shell is never silently downgraded', () => {
  it.each(['pwsh', 'bash'])('reports %s as unavailable instead of falling back', async (shell) => {
    await withNoShells(async () => {
      const r = await bashCallTool('run', { command: 'echo must-not-run', shell });
      const out = parse(r);
      expect(r.isError).toBe(true);
      expect(out).not.toHaveProperty('shellFallback');
      expect(out.requestedShell).toBe(shell);
      expect(out.shell).toBe(shell);
      expect(out.error).toContain('could not be resolved');
      expect(Array.isArray(out.availableShells)).toBe(true);
      expect(typeof out.hint).toBe('string');
      expect(out.output).toBeUndefined();
      expect(mockedSpawn).not.toHaveBeenCalled();
    });
  });

  it('rejects an unavailable explicit shell for background execution too', async () => {
    await withNoShells(async () => {
      const r = await bashCallTool('start', { command: 'echo must-not-run', shell: 'pwsh' });
      const out = parse(r);
      expect(r.isError).toBe(true);
      expect(out).not.toHaveProperty('shellFallback');
      expect(out.shell).toBe('pwsh');
      expect(out.sessionId).toBeUndefined();
      expect(mockedSpawn).not.toHaveBeenCalled();
    });
  });

  it('reports cmd as unavailable off Windows rather than substituting a POSIX shell', async () => {
    if (isWin) return;
    const r = await bashCallTool('run', { command: 'echo must-not-run', shell: 'cmd' });
    const out = parse(r);
    expect(r.isError).toBe(true);
    expect(out.shell).toBe('cmd');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('substitutes Windows PowerShell for a missing pwsh, loudly and within the same dialect', async () => {
    if (!isWin) return;
    const systemRoot = process.env.SystemRoot ?? process.env.windir;
    if (!systemRoot) return;
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-314-nopwsh-'));
    try {
      // pwsh is unreachable (empty PATH / ProgramFiles / WindowsApps), but the
      // real Windows PowerShell 5.1 under %SystemRoot% still is.
      await withShellEnv(
        { PATH: empty, Path: empty, PATHEXT: '.EXE', ProgramFiles: empty, LocalAppData: empty, SystemRoot: systemRoot },
        async () => {
          mockCompletedChild('substituted');
          const r = await bashCallTool('run', { command: 'Get-Location', shell: 'pwsh' });
          const out = parse(r);
          expect(out).not.toHaveProperty('shellFallback');
          expect(out.requestedShell).toBe('pwsh');
          expect(out.shell).toBe('powershell');
          expect(out.shellSubstitution).toEqual({
            requested: 'pwsh',
            used: 'powershell',
            reason: expect.stringContaining('pwsh'),
          });
        },
      );
    } finally {
      await fsp.rm(empty, { recursive: true, force: true });
    }
  });
});

describe('issue #314 — the WSL bash relay is never selected as "bash"', () => {
  it('treats a System32-only bash.exe as unavailable and points at Git Bash', async () => {
    if (!isWin) return;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-314-wsl-'));
    const fakeSystemRoot = path.join(tempDir, 'Windows');
    const system32 = path.join(fakeSystemRoot, 'System32');
    await fsp.mkdir(system32, { recursive: true });
    const wslBash = path.join(system32, 'bash.exe');
    await fsp.writeFile(wslBash, 'wsl relay placeholder');
    try {
      await withShellEnv(
        {
          PATH: system32,
          Path: system32,
          PATHEXT: '.EXE',
          SystemRoot: fakeSystemRoot,
          ProgramFiles: tempDir,
          LocalAppData: tempDir,
        },
        async () => {
          const r = await bashCallTool('run', { command: 'echo must-not-run', shell: 'bash' });
          const out = parse(r);
          expect(r.isError).toBe(true);
          expect(out.shell).toBe('bash');
          expect(String(out.hint)).toContain('Git for Windows');
          expect(mockedSpawn).not.toHaveBeenCalled();
        },
      );
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('issue #314 — missing executables are named, not hidden behind a localized message', () => {
  const nothingAvailable = () => false;
  const everythingAvailable = () => true;

  it('names rg when it is not installed', () => {
    const warnings = detectDialectMismatch('rg -n "ProcessNodeModal" .', 'powershell', nothingAvailable);
    expect(warnings.join(' ')).toContain('"rg"');
    expect(detectDialectMismatch('rg -n "x" .', 'powershell', everythingAvailable)).toEqual([]);
  });

  it('names head when it is only reachable through a pipeline', () => {
    const warnings = detectDialectMismatch('git grep needle | head -20', 'cmd', nothingAvailable);
    expect(warnings.join(' ')).toContain('"head"');
  });

  it('stays silent for cmd builtins and PowerShell cmdlets', () => {
    expect(detectDialectMismatch('dir /b', 'cmd', nothingAvailable)).toEqual([]);
    expect(detectDialectMismatch('Get-ChildItem -Force', 'pwsh', nothingAvailable)).toEqual([]);
  });
});
