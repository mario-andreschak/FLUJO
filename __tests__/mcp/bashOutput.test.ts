/**
 * Output semantics of the built-in `bash` MCP server (issue #364): stderr is
 * logging (not failure), floods keep head AND tail, `outputFile` spools the full
 * text under root confinement, and timeouts explain themselves.
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
  _resetBashSessionsForTests,
  _resetBashShellCacheForTests,
} from '@/backend/services/mcp/internal/bashTools';

const mockedRoots = loadServerRoots as jest.Mock;
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

function parse(result: CallToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

/** Mock a child that writes to stdout/stderr and then exits with `code`. */
function mockChild(options: { stdout?: string; stderr?: string; code?: number | null; close?: boolean }): void {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: new PassThrough(),
    pid: undefined,
    killed: false,
  }) as unknown as ChildProcess;

  mockedSpawn.mockImplementationOnce((() => {
    setImmediate(() => {
      if (options.stdout) stdout.write(Buffer.from(options.stdout, 'utf8'));
      if (options.stderr) stderr.write(Buffer.from(options.stderr, 'utf8'));
      stdout.end();
      stderr.end();
      if (options.close !== false) setImmediate(() => child.emit('close', options.code ?? 0));
    });
    return child;
  }) as typeof spawn);
}

let dataDir = '';

beforeEach(async () => {
  const { getDataDir } = await import('@/utils/paths');
  dataDir = getDataDir();
  mockedRoots.mockResolvedValue([dataDir]);
});

afterEach(() => {
  _resetBashSessionsForTests();
  _resetBashShellCacheForTests();
  mockedSpawn.mockClear();
  mockedRoots.mockReset();
});

describe('exit-code semantics', () => {
  it('treats stderr output on a zero exit as success and counts it separately', async () => {
    mockChild({ stdout: 'ok\n', stderr: 'ffmpeg version banner\n', code: 0 });
    const result = await bashCallTool('run', { command: 'ffmpeg -version' });
    const payload = parse(result);
    expect(result.isError).toBeFalsy();
    expect(payload.exitCode).toBe(0);
    expect(payload.output).toContain('ffmpeg version banner');
    expect(payload.stderrChars as number).toBeGreaterThan(0);
  });

  it('still reports a non-zero exit as an error', async () => {
    mockChild({ stdout: '', stderr: 'boom\n', code: 3 });
    const result = await bashCallTool('run', { command: 'exit 3' });
    expect(result.isError).toBe(true);
    expect(parse(result).exitCode).toBe(3);
  });
});

describe('output flood control', () => {
  it('keeps the head and the tail when the cap is exceeded', async () => {
    mockChild({ stdout: `HEAD_MARKER${'x'.repeat(5_000)}TAIL_MARKER`, code: 0 });
    const payload = parse(await bashCallTool('run', { command: 'noisy', maxOutputChars: 1_000 }));
    const output = String(payload.output);
    expect(output).toContain('HEAD_MARKER');
    expect(output).toContain('TAIL_MARKER');
    expect(output).toMatch(/characters of output omitted/);
    expect(payload.truncated).toBe(true);
    expect(payload.omittedChars as number).toBeGreaterThan(0);
    expect(payload.outputChars).toBe('HEAD_MARKER'.length + 5_000 + 'TAIL_MARKER'.length);
  });

  it('spools the full output to outputFile inside the roots', async () => {
    const relative = `bash-output-${Date.now()}.log`;
    const absolute = path.join(dataDir, relative);
    const full = `START${'y'.repeat(3_000)}END`;
    mockChild({ stdout: full, code: 0 });
    try {
      const payload = parse(await bashCallTool('run', {
        command: 'noisy',
        maxOutputChars: 1_000,
        outputFile: relative,
      }));
      expect(payload.outputFile).toBe(absolute);
      expect(payload.outputBytes as number).toBeGreaterThan(0);
      // Give the write stream a tick to flush.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await fsp.readFile(absolute, 'utf8')).toBe(full);
    } finally {
      await fsp.rm(absolute, { force: true });
    }
  });

  it('rejects an outputFile outside the configured roots', async () => {
    const outside = path.join(os.tmpdir(), 'flujo-bash-outside.log');
    const payload = parse(await bashCallTool('run', { command: 'echo hi', outputFile: outside }));
    expect(String(payload.error)).toMatch(/outside the configured bash roots/);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

describe('timeout transparency', () => {
  it('explains the timeout and the process-tree kill', async () => {
    mockChild({ stdout: 'working…', close: false });
    const payload = parse(await bashCallTool('run', { command: 'git log', timeout: 0.05 }));
    expect(payload.timedOut).toBe(true);
    expect(payload.timeoutMs).toBe(50);
    expect(typeof payload.elapsedMs).toBe('number');
    expect(payload.killedProcessTree).toBe(true);
    expect(String(payload.suggestion)).toMatch(/start.*wait/);
    expect((payload.hangHints as string[]).join(' ')).toMatch(/--no-pager/);
  });
});
