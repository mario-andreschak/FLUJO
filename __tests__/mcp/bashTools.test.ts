/**
 * Tests for the built-in `bash` MCP server (issue #170): foreground run
 * (output/exit code, non-zero exit, timeout kill) and background sessions
 * (start → wait → result, kill a long runner, unknown-session errors).
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

jest.mock('@/backend/services/mcp/internal/registry', () => ({
  BASH_SERVER_NAME: 'bash',
  getInternalServerRoots: jest.fn(),
}));

import { getInternalServerRoots } from '@/backend/services/mcp/internal/registry';
import {
  bashToolDefinitions,
  bashCallTool,
  _resetBashSessionsForTests,
  _resetBashShellCacheForTests,
} from '@/backend/services/mcp/internal/bashTools';

const mockedRoots = getInternalServerRoots as jest.Mock;

function text(r: CallToolResult): string {
  const first = r.content[0] as { text: string };
  return first.text;
}
function parse(r: CallToolResult): Record<string, unknown> {
  return JSON.parse(text(r));
}

const isWin = process.platform === 'win32';
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function mockCompletedChild(output: string): void {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: new PassThrough(),
    pid: 12345,
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

async function withResolvedPwsh(run: (executable: string) => Promise<void>): Promise<void> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-pwsh-'));
  const executable = path.join(tempDir, isWin ? 'pwsh.EXE' : 'pwsh');
  const originalPath = process.env.PATH;
  const originalWinPath = process.env.Path;
  const originalPathExt = process.env.PATHEXT;
  await fsp.writeFile(executable, 'test executable placeholder');
  process.env.PATH = tempDir;
  process.env.Path = tempDir;
  if (isWin) process.env.PATHEXT = '.EXE';
  _resetBashShellCacheForTests();

  try {
    await run(executable);
  } finally {
    restoreEnv('PATH', originalPath);
    restoreEnv('Path', originalWinPath);
    restoreEnv('PATHEXT', originalPathExt);
    _resetBashShellCacheForTests();
    await fsp.rm(tempDir, { recursive: true, force: true });
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

describe('bash tool definitions', () => {
  it('exposes foreground run + background session tools', () => {
    const tools = bashToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['run', 'start', 'status', 'wait', 'write_stdin', 'kill', 'list_sessions'])
    );
    for (const tool of tools.filter((candidate) => candidate.name !== 'run')) {
      expect(tool._meta).toEqual(expect.objectContaining({
        ui: { resourceUri: 'ui://bash/terminal' },
      }));
    }
  });
});

describe('bash run (foreground)', () => {
  it('runs a command and returns its output + exit code', async () => {
    const r = await bashCallTool('run', { command: 'echo hello-bash' });
    expect(r.isError).toBeUndefined();
    const out = parse(r);
    expect(out.output as string).toContain('hello-bash');
    expect(out.exitCode).toBe(0);
  });

  it('reports a non-zero exit as an error result', async () => {
    const r = await bashCallTool('run', { command: 'exit 3' });
    expect(r.isError).toBe(true);
    expect(parse(r).exitCode).toBe(3);
  });

  it('requires a command', async () => {
    const r = await bashCallTool('run', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('command');
  });

  it('kills a command that exceeds the timeout', async () => {
    const command = isWin ? 'ping -n 6 127.0.0.1 > NUL' : 'sleep 5';
    const r = await bashCallTool('run', { command, timeout: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('timedOut');
  }, 20000);

  it('normalizes CRLF to LF when requested', async () => {
    const r = await bashCallTool('run', { command: 'echo hi', normalizeNewlines: true });
    expect(text(r)).not.toContain('\r');
  });

  it('makes the ripgrep bundled with the Codex dependency available on PATH', async () => {
    const r = await bashCallTool('run', { command: 'rg --version' });
    expect(r.isError).toBeUndefined();
    expect(parse(r).output as string).toMatch(/^ripgrep \d+/);
  });

  it.each([
    "rg needle -g '/.git/**' .",
    "rg needle --glob '!/.git/**' .",
    "rg needle --glob='/.git/**' .",
    "rg needle --iglob '/.git/**' .",
  ])('does not treat a ripgrep glob as an external path: %s', async (command) => {
    const r = await bashCallTool('run', { command });
    expect(parse(r).warnings).toBeUndefined();
  });

  it('continues warning about genuine absolute paths', async () => {
    const r = await bashCallTool('run', { command: 'echo /.git/config' });
    expect(parse(r).warnings).toBeDefined();
  });
});

describe('bash shell selection (issues #225, #327)', () => {
  it('runs an explicit foreground pwsh request directly with PowerShell arguments', async () => {
    await withResolvedPwsh(async (executable) => {
      mockCompletedChild('pwsh-foreground-marker');
      const command = "Write-Output 'pwsh-foreground-marker'";
      const r = await bashCallTool('run', { command, shell: 'pwsh' });

      expect(r.isError).toBeUndefined();
      expect(parse(r)).toEqual(expect.objectContaining({
        shell: 'pwsh',
        exitCode: 0,
        output: 'pwsh-foreground-marker',
      }));
      expect(mockedSpawn).toHaveBeenCalledWith(
        executable,
        ['-NoProfile', '-NonInteractive', '-Command', command],
        expect.objectContaining({ shell: false })
      );
    });
  });

  it('retains an explicit pwsh request when starting a background session', async () => {
    await withResolvedPwsh(async (executable) => {
      mockCompletedChild('pwsh-background-marker');
      const command = "Write-Output 'pwsh-background-marker'";
      const startedResult = await bashCallTool('start', { command, shell: 'pwsh' });
      const started = parse(startedResult);

      expect(startedResult.isError).toBeUndefined();
      expect(started.shell).toBe('pwsh');
      expect(started.sessionId).toBeTruthy();
      expect(mockedSpawn).toHaveBeenCalledWith(
        executable,
        ['-NoProfile', '-NonInteractive', '-Command', command],
        expect.objectContaining({ shell: false })
      );

      const waited = parse(await bashCallTool('wait', {
        sessionId: started.sessionId as string,
        timeout: 10,
      }));
      expect(waited.running).toBe(false);
      expect(waited.output).toBe('pwsh-background-marker');
    });
  });

  it('rejects a noncanonical foreground shell before starting a child process', async () => {
    const r = await bashCallTool('run', {
      command: 'echo must-not-run',
      shell: 'PWSH',
    });

    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual(expect.objectContaining({
      error: expect.stringContaining('Invalid shell request'),
      requestedShell: 'PWSH',
    }));
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('rejects a non-string background shell before starting a child process', async () => {
    const r = await bashCallTool('start', {
      command: 'echo must-not-run',
      shell: 42,
    });

    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual(expect.objectContaining({
      error: expect.stringContaining('Invalid shell request'),
      requestedShell: 42,
    }));
    expect(parse(r).sessionId).toBeUndefined();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('resolves "bash" to a real bash executable exposing unix utilities, when one is installed', async () => {
    const r = await bashCallTool('run', { command: 'echo bash-test | grep -q bash-test && echo found', shell: 'bash' });
    const out = parse(r);
    if (r.isError) return; // No bash install found on this machine at all — nothing to assert.
    expect(out.shell).toBe('bash');
    expect(out.output as string).toContain('found');
  });

  it('returns an explicit error without executing when the requested shell is unavailable', async () => {
    const originalPath = process.env.PATH;
    const originalWinPath = process.env.Path;
    const originalProgramFiles = process.env.ProgramFiles;
    const originalProgramFilesX86 = process.env['ProgramFiles(x86)'];
    const originalLocalAppData = process.env.LocalAppData;
    process.env.PATH = '';
    process.env.Path = '';
    process.env.ProgramFiles = '';
    delete process.env['ProgramFiles(x86)'];
    process.env.LocalAppData = '';
    try {
      _resetBashShellCacheForTests();
      const r = await bashCallTool('run', { command: 'echo must-not-run', shell: 'bash' });
      const out = parse(r);
      expect(r.isError).toBe(true);
      expect(out.shell).toBe('bash');
      expect(out.error).toContain('could not be resolved');
      expect(out.output).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      process.env.Path = originalWinPath;
      process.env.ProgramFiles = originalProgramFiles;
      if (originalProgramFilesX86 !== undefined) process.env['ProgramFiles(x86)'] = originalProgramFilesX86;
      process.env.LocalAppData = originalLocalAppData;
    }
  });

  it('rejects an unavailable explicit shell for background execution', async () => {
    const originalPath = process.env.PATH;
    const originalWinPath = process.env.Path;
    process.env.PATH = '';
    process.env.Path = '';
    try {
      _resetBashShellCacheForTests();
      const r = await bashCallTool('start', { command: 'echo must-not-run', shell: 'pwsh' });
      const out = parse(r);
      expect(r.isError).toBe(true);
      expect(out.shell).toBe('pwsh');
      expect(out.sessionId).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
      process.env.Path = originalWinPath;
    }
  });

  it('does not report a Windows dir /b switch as an external path', async () => {
    if (!isWin) return;
    const r = await bashCallTool('run', { command: 'echo dir /b' });
    expect(parse(r).warnings).toBeUndefined();
  });
});

describe('bash background sessions', () => {
  it('starts a session, waits for it, and reads the result', async () => {
    const start = parse(await bashCallTool('start', { command: 'echo bg-done' }));
    expect(start.sessionId).toBeTruthy();
    const waited = parse(await bashCallTool('wait', { sessionId: start.sessionId as string, timeout: 10 }));
    expect(waited.running).toBe(false);
    expect(waited.output as string).toContain('bg-done');

    const list = parse(await bashCallTool('list_sessions', {}));
    const ids = (list.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
    expect(ids).toContain(start.sessionId);
  }, 20000);

  it('kills a long-running background session', async () => {
    const command = isWin ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30';
    const start = parse(await bashCallTool('start', { command }));
    const killed = parse(await bashCallTool('kill', { sessionId: start.sessionId as string }));
    expect(killed.killed).toBe(true);
    const waited = parse(await bashCallTool('wait', { sessionId: start.sessionId as string, timeout: 10 }));
    expect(waited.running).toBe(false);
  }, 25000);

  it('isolates session visibility and controls by host-derived owner scope', async () => {
    const ownerA = 'conversation:alpha';
    const ownerB = 'conversation:beta';
    const started = parse(await bashCallTool('start', { command: 'echo scoped' }, undefined, ownerA));
    const sessionId = started.sessionId as string;

    const denied = await bashCallTool('status', { sessionId }, undefined, ownerB);
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('No background session');

    const listA = parse(await bashCallTool('list_sessions', {}, undefined, ownerA));
    const listB = parse(await bashCallTool('list_sessions', {}, undefined, ownerB));
    expect(listA.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId })]));
    expect(listB.sessions).toEqual([]);

    const waited = parse(await bashCallTool('wait', { sessionId, timeout: 10 }, undefined, ownerA));
    expect(waited.output as string).toContain('scoped');
  }, 20000);

  it('errors on an unknown session id', async () => {
    const r = await bashCallTool('status', { sessionId: 'does-not-exist' });
    expect(r.isError).toBe(true);
  });
});
