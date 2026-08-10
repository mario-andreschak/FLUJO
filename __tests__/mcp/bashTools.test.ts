/**
 * Tests for the shipped `bash` MCP package (issue #170): foreground run
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

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerRoots: jest.fn(),
}));

import { loadServerRoots } from '@/backend/services/mcp/config';
import {
  bashToolDefinitions,
  bashCallTool,
  _resetBashSessionsForTests,
  _resetBashShellCacheForTests,
  _resolveCommandTimeoutMsForTests,
  wrapPowerShellCommand,
  wrapCmdCommand,
} from '@/backend/services/mcp/internal/bashTools';

const mockedRoots = loadServerRoots as jest.Mock;

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

function mockNeverClosingChild(): void {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: undefined,
    killed: false,
  }) as unknown as ChildProcess;
  mockedSpawn.mockImplementationOnce((() => child) as typeof spawn);
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
  it('exposes foreground, background, and PTY terminal tools with correct app visibility', () => {
    const tools = bashToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'run', 'start', 'status', 'wait', 'write_stdin', 'kill', 'list_sessions',
        'open_terminal', 'terminal_read', 'terminal_write', 'terminal_resize', 'terminal_close', 'terminal_list',
      ])
    );
    expect(tools.find((tool) => tool.name === 'open_terminal')?._meta).toEqual({
      ui: { resourceUri: 'ui://bash/terminal', visibility: ['model', 'app'] },
    });
    for (const name of ['terminal_read', 'terminal_write', 'terminal_resize', 'terminal_close', 'terminal_list']) {
      expect(tools.find((tool) => tool.name === name)?._meta).toEqual({
        ui: { resourceUri: 'ui://bash/terminal', visibility: ['app'] },
      });
    }
    expect(tools.find((tool) => tool.name === 'start')?._meta).toBeUndefined();
    const run = tools.find((tool) => tool.name === 'run');
    expect(run?.description).toContain('Run one command to completion');
    expect(run?.inputSchema.properties?.shell).toEqual(expect.objectContaining({
      enum: ['default', 'pwsh', 'bash', 'cmd'],
    }));
    expect(run?.inputSchema.properties?.timeout).toEqual(expect.objectContaining({
      description: expect.stringContaining('-1 disables it'),
    }));
  });

  it('allows multi-hour and explicitly unbounded foreground timeouts', () => {
    expect(_resolveCommandTimeoutMsForTests(301)).toBe(301_000);
    expect(_resolveCommandTimeoutMsForTests(3_600)).toBe(3_600_000);
    expect(_resolveCommandTimeoutMsForTests(-1)).toBeUndefined();
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
    // NOTE: no `> NUL` here — that is cmd redirection syntax and fails instantly
    // under PowerShell (exactly the dialect trap issue #364 is about).
    const command = isWin ? 'ping -n 6 127.0.0.1' : 'sleep 5';
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
      const command = "$value = 'a|b&c;d \"quoted\"'; Write-Output $value";
      const r = await bashCallTool('run', { command, shell: 'pwsh' });

      expect(r.isError).toBeUndefined();
      expect(parse(r)).toEqual(expect.objectContaining({
        shell: 'pwsh',
        exitCode: 0,
        output: 'pwsh-foreground-marker',
      }));
      expect(mockedSpawn).toHaveBeenCalledWith(
        executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapPowerShellCommand(command)],
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
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapPowerShellCommand(command)],
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

  it('prefers Git Bash over the Windows WSL bash launcher', async () => {
    if (!isWin) return;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-git-bash-'));
    const gitBash = path.join(tempDir, 'Git', 'bin', 'bash.exe');
    const fakeSystemRoot = path.join(tempDir, 'Windows');
    const wslBash = path.join(fakeSystemRoot, 'System32', 'bash.exe');
    const originalPath = process.env.PATH;
    const originalProgramFiles = process.env.ProgramFiles;
    const originalSystemRoot = process.env.SystemRoot;
    const originalPathExt = process.env.PATHEXT;
    await fsp.mkdir(path.dirname(gitBash), { recursive: true });
    await fsp.mkdir(path.dirname(wslBash), { recursive: true });
    await Promise.all([
      fsp.writeFile(gitBash, 'git bash placeholder'),
      fsp.writeFile(wslBash, 'wsl launcher placeholder'),
    ]);
    process.env.ProgramFiles = tempDir;
    process.env.SystemRoot = fakeSystemRoot;
    process.env.PATH = path.dirname(wslBash);
    process.env.PATHEXT = '.EXE';
    try {
      _resetBashShellCacheForTests();
      mockCompletedChild('git-bash-marker');
      const r = await bashCallTool('run', { command: 'printf git-bash-marker', shell: 'bash' });
      expect(r.isError).toBeUndefined();
      expect(parse(r).shell).toBe('bash');
      expect(mockedSpawn).toHaveBeenCalledWith(
        gitBash,
        ['-c', 'printf git-bash-marker'],
        expect.objectContaining({ shell: false }),
      );
    } finally {
      restoreEnv('PATH', originalPath);
      restoreEnv('ProgramFiles', originalProgramFiles);
      restoreEnv('SystemRoot', originalSystemRoot);
      restoreEnv('PATHEXT', originalPathExt);
      _resetBashShellCacheForTests();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('finds a WindowsApps pwsh alias even when it is absent from PATH', async () => {
    if (!isWin) return;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-windowsapps-pwsh-'));
    const executable = path.join(tempDir, 'Microsoft', 'WindowsApps', 'pwsh.exe');
    const originalPath = process.env.PATH;
    const originalLocalAppData = process.env.LocalAppData;
    const originalProgramFiles = process.env.ProgramFiles;
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.windir;
    await fsp.mkdir(path.dirname(executable), { recursive: true });
    process.env.PATH = '';
    process.env.LocalAppData = tempDir;
    // Windows PowerShell 5.1 would otherwise be substituted for the missing
    // pwsh (issue #314); hide it so "no PowerShell at all" is really tested.
    process.env.ProgramFiles = tempDir;
    delete process.env.SystemRoot;
    delete process.env.windir;
    try {
      _resetBashShellCacheForTests();
      const unavailable = await bashCallTool('run', {
        command: 'Write-Output must-not-run',
        shell: 'pwsh',
      });
      expect(unavailable.isError).toBe(true);

      await fsp.writeFile(executable, 'pwsh app execution alias placeholder');
      mockCompletedChild('windowsapps-pwsh-marker');
      const r = await bashCallTool('run', { command: 'Write-Output windowsapps-pwsh-marker', shell: 'pwsh' });
      expect(r.isError).toBeUndefined();
      expect(mockedSpawn).toHaveBeenCalledWith(
        executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapPowerShellCommand('Write-Output windowsapps-pwsh-marker')],
        expect.objectContaining({ shell: false }),
      );
    } finally {
      restoreEnv('PATH', originalPath);
      restoreEnv('LocalAppData', originalLocalAppData);
      restoreEnv('ProgramFiles', originalProgramFiles);
      restoreEnv('SystemRoot', originalSystemRoot);
      restoreEnv('windir', originalWindir);
      _resetBashShellCacheForTests();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('restores executable extensions when the inherited PATHEXT is incomplete', async () => {
    if (!isWin) return;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-pathext-pwsh-'));
    const executable = path.join(tempDir, 'pwsh.EXE');
    const originalPath = process.env.PATH;
    const originalPathExt = process.env.PATHEXT;
    await fsp.writeFile(executable, 'pwsh executable placeholder');
    process.env.PATH = tempDir;
    process.env.PATHEXT = '.CPL';
    try {
      _resetBashShellCacheForTests();
      mockCompletedChild('pathext-marker');
      const r = await bashCallTool('run', { command: 'Write-Output pathext-marker', shell: 'pwsh' });
      expect(r.isError).toBeUndefined();
      expect(mockedSpawn.mock.calls[0]?.[0]).toBe(executable);
      const childPathExt = mockedSpawn.mock.calls[0]?.[2]?.env?.PATHEXT;
      expect(childPathExt?.split(';')).toEqual(expect.arrayContaining(['.COM', '.EXE', '.BAT', '.CMD', '.CPL']));
    } finally {
      restoreEnv('PATH', originalPath);
      restoreEnv('PATHEXT', originalPathExt);
      _resetBashShellCacheForTests();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses PowerShell for the Windows default and reports the effective parser', async () => {
    if (!isWin) return;
    await withResolvedPwsh(async (executable) => {
      mockCompletedChild('default-pwsh-marker');
      const command = "Get-Process | Select-Object -First 1 ProcessName";
      const r = await bashCallTool('run', { command });
      expect(parse(r)).toEqual(expect.objectContaining({
        requestedShell: 'default',
        shell: 'pwsh',
      }));
      expect(mockedSpawn).toHaveBeenCalledWith(
        executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapPowerShellCommand(command)],
        expect.objectContaining({ shell: false }),
      );
    });
  });

  it('passes cmd metacharacters verbatim instead of re-quoting the command', async () => {
    if (!isWin) return;
    mockCompletedChild('cmd-special-marker');
    const command = 'rg -n -i "alpha|beta & gamma" src __tests__';
    const r = await bashCallTool('run', { command, shell: 'cmd' });
    expect(r.isError).toBeUndefined();
    expect(parse(r).shell).toBe('cmd');
    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/cmd\.exe$/i),
      ['/d', '/s', '/c', wrapCmdCommand(command)],
      expect.objectContaining({
        shell: false,
        windowsVerbatimArguments: true,
      }),
    );
  });

  it('passes explicit command environment variables without shell interpolation', async () => {
    await withResolvedPwsh(async () => {
      mockCompletedChild('env-marker');
      const r = await bashCallTool('run', {
        command: 'Write-Output $env:FLUJO_TEST_MARKER',
        shell: 'pwsh',
        env: { FLUJO_TEST_MARKER: 'value with spaces & | ; "quotes"' },
      });
      expect(r.isError).toBeUndefined();
      const options = mockedSpawn.mock.calls[0]?.[2];
      expect(options?.env).toEqual(expect.objectContaining({
        FLUJO_TEST_MARKER: 'value with spaces & | ; "quotes"',
      }));
    });
  });

  it('preserves essential inherited environment variables case-insensitively', async () => {
    if (!isWin) return;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Flujo Case Sensitive Env Test';
    try {
      await withResolvedPwsh(async () => {
        mockCompletedChild('inherited-env-marker');
        const r = await bashCallTool('run', {
          command: 'Write-Output $env:LOCALAPPDATA',
          shell: 'pwsh',
        });
        expect(r.isError).toBeUndefined();
        const env = mockedSpawn.mock.calls[0]?.[2]?.env ?? {};
        const inherited = Object.entries(env).find(([key]) => key.toLowerCase() === 'localappdata');
        expect(inherited?.[1]).toBe('C:\\Flujo Case Sensitive Env Test');
      });
    } finally {
      restoreEnv('LOCALAPPDATA', originalLocalAppData);
    }
  });

  it('rejects malformed command environment variables before spawning', async () => {
    const r = await bashCallTool('run', {
      command: 'echo must-not-run',
      env: { VALID: 42 },
    });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toContain('must be a string');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('settles at the timeout even when the child never emits close', async () => {
    await withResolvedPwsh(async () => {
      mockNeverClosingChild();
      const r = await bashCallTool('run', {
        command: 'never-closes',
        shell: 'pwsh',
        timeout: 0.01,
      });
      expect(r.isError).toBe(true);
      expect(parse(r)).toEqual(expect.objectContaining({
        timedOut: true,
        exitCode: null,
      }));
    });
  });

  it('forwards output chunks as progress and settles promptly on cancellation', async () => {
    await withResolvedPwsh(async () => {
      const progress = jest.fn();
      mockCompletedChild('streamed-marker');
      const completed = await bashCallTool(
        'run',
        { command: 'stream-output', shell: 'pwsh' },
        undefined,
        undefined,
        { onProgress: progress },
      );
      await Promise.resolve();
      expect(completed.isError).toBeUndefined();
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({
        message: 'streamed-marker',
      }));

      mockNeverClosingChild();
      const controller = new AbortController();
      const pending = bashCallTool(
        'run',
        { command: 'cancel-me', shell: 'pwsh', timeout: 60 },
        undefined,
        undefined,
        { signal: controller.signal },
      );
      for (let attempt = 0; attempt < 100 && mockedSpawn.mock.calls.length < 2; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(mockedSpawn.mock.calls).toHaveLength(2);
      controller.abort();
      const cancelled = await pending;
      expect(cancelled.isError).toBe(true);
      expect(parse(cancelled).cancelled).toBe(true);
    });
  });

  it('emits strictly increasing MCP progress values across a large output burst', async () => {
    await withResolvedPwsh(async () => {
      const progress = jest.fn();
      mockCompletedChild('x'.repeat(9_000));
      const completed = await bashCallTool(
        'run',
        { command: 'stream-large-output', shell: 'pwsh' },
        undefined,
        undefined,
        { onProgress: progress },
      );
      expect(completed.isError).toBeUndefined();
      const values = progress.mock.calls.map(([update]) => update.progress as number);
      expect(values.length).toBeGreaterThan(1);
      for (let i = 1; i < values.length; i += 1) {
        expect(values[i]).toBeGreaterThan(values[i - 1]);
      }
    });
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
    const originalProgramFiles = process.env.ProgramFiles;
    const originalLocalAppData = process.env.LocalAppData;
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.windir;
    process.env.PATH = '';
    process.env.Path = '';
    process.env.ProgramFiles = '';
    process.env.LocalAppData = '';
    // No pwsh AND no Windows PowerShell 5.1: the request must fail rather than
    // be substituted (issue #314).
    delete process.env.SystemRoot;
    delete process.env.windir;
    try {
      _resetBashShellCacheForTests();
      const r = await bashCallTool('start', { command: 'echo must-not-run', shell: 'pwsh' });
      const out = parse(r);
      expect(r.isError).toBe(true);
      expect(out.shell).toBe('pwsh');
      expect(out.sessionId).toBeUndefined();
    } finally {
      restoreEnv('PATH', originalPath);
      restoreEnv('Path', originalWinPath);
      restoreEnv('ProgramFiles', originalProgramFiles);
      restoreEnv('LocalAppData', originalLocalAppData);
      restoreEnv('SystemRoot', originalSystemRoot);
      restoreEnv('windir', originalWindir);
    }
  });

  it.each([
    'echo dir /b',
    'cd . && dir /b',
    'dir /ad',
    'xcopy /s /e src dst',
    'robocopy src dst /mir',
  ])('does not report a Windows switch as an external path: %s', async (command) => {
    if (!isWin) return;
    // The child is mocked: only the advisory scan is under test here.
    mockCompletedChild('ok');
    const r = await bashCallTool('run', { command });
    expect(parse(r).warnings).toBeUndefined();
  });

  it('still warns about a genuine path in a segment without a Windows utility', async () => {
    if (!isWin) return;
    mockCompletedChild('ok');
    const r = await bashCallTool('run', { command: 'dir /b && echo /etc/passwd' });
    expect(parse(r).warnings).toEqual([
      expect.stringContaining('/etc/passwd'),
    ]);
  });
});

describe('bash background sessions', () => {
  it('starts multiple independent sessions in parallel', async () => {
    mockCompletedChild('parallel-one');
    mockCompletedChild('parallel-two');
    mockCompletedChild('parallel-three');
    const started = await Promise.all(
      ['one', 'two', 'three'].map(async (marker) =>
        parse(await bashCallTool('start', { command: `echo ${marker}` }))
      ),
    );
    expect(new Set(started.map((entry) => entry.sessionId))).toHaveProperty('size', 3);
    const listed = parse(await bashCallTool('list_sessions', {}));
    expect(listed.sessions).toHaveLength(3);
  });

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

  it('streams background output while wait observes the session', async () => {
    mockCompletedChild('background-progress-marker');
    const started = parse(await bashCallTool('start', { command: 'background-progress' }));
    const progress = jest.fn();
    const waited = await bashCallTool(
      'wait',
      { sessionId: started.sessionId as string, timeout: 10 },
      undefined,
      undefined,
      { onProgress: progress },
    );
    expect(waited.isError).toBeUndefined();
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      message: 'background-progress-marker',
    }));
  });

  it('kills a long-running background session', async () => {
    const command = isWin ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30';
    const start = parse(await bashCallTool('start', { command }));
    const killed = parse(await bashCallTool('kill', { sessionId: start.sessionId as string }));
    expect(killed.killed).toBe(true);
    const waited = parse(await bashCallTool('wait', { sessionId: start.sessionId as string, timeout: 10 }));
    expect(waited.running).toBe(false);
  }, 25000);

  it('cancels a wait call without killing or orphaning the background session', async () => {
    mockNeverClosingChild();
    const started = parse(await bashCallTool('start', { command: 'background-stays-running' }));
    const controller = new AbortController();
    const waiting = bashCallTool(
      'wait',
      { sessionId: started.sessionId as string, timeout: 60 },
      undefined,
      undefined,
      { signal: controller.signal },
    );
    controller.abort();
    const cancelled = await waiting;
    expect(cancelled.isError).toBe(true);
    expect(parse(cancelled)).toEqual(expect.objectContaining({
      cancelled: true,
      running: true,
    }));
  });

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
