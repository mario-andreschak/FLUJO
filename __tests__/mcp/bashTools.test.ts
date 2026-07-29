/**
 * Tests for the built-in `bash` MCP server (issue #170): foreground run
 * (output/exit code, non-zero exit, timeout kill) and background sessions
 * (start → wait → result, kill a long runner, unknown-session errors).
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

beforeEach(async () => {
  const { getDataDir } = await import('@/utils/paths');
  mockedRoots.mockResolvedValue([getDataDir()]);
});

afterEach(() => {
  _resetBashSessionsForTests();
  _resetBashShellCacheForTests();
  mockedRoots.mockReset();
});

describe('bash tool definitions', () => {
  it('exposes foreground run + background session tools', () => {
    const names = bashToolDefinitions().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['run', 'start', 'status', 'wait', 'write_stdin', 'kill', 'list_sessions'])
    );
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
});

describe('bash shell selection (issue #225)', () => {
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

  it('errors on an unknown session id', async () => {
    const r = await bashCallTool('status', { sessionId: 'does-not-exist' });
    expect(r.isError).toBe(true);
  });
});
