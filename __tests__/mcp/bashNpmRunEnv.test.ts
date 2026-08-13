/**
 * Regression suite: running `npm run <script>` (and therefore Jest) through the
 * internal bash MCP server on Windows.
 *
 * FLUJO hands every stdio MCP server an explicit `env`, and the MCP SDK's
 * default Windows inherit list carries neither ComSpec nor windir. npm resolves
 * its script shell from `process.env.ComSpec` with no fallback of its own, so the
 * bash server used to pass npm a blank one: `npm run typecheck:mcp`,
 * `npm run test:mcp` and `npm run test:mcp-process-boundary` printed npm's banner
 * and then died inside `normalizeSpawnArguments` with
 * `ERR_INVALID_ARG_TYPE: The "file" argument must be of type string. Received
 * undefined`. npm swallows its own diagnostics on that crash path, so the agent
 * only ever saw "exit code 1, no output" while a direct `npx jest` run worked.
 */
import fs from 'fs';
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
const itOnWindows = process.platform === 'win32' ? it : it.skip;

function parse(result: CallToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

/** Every spelling of `name` that carries a real value. */
function valuedSpellings(env: Record<string, string | undefined>, name: string): string[] {
  return Object.keys(env).filter(
    (key) => key.toLowerCase() === name.toLowerCase() && (env[key] ?? '').trim() !== '',
  );
}

/** Replace the next spawn with a child that immediately succeeds. */
function mockCompletedChild(): void {
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
      stdout.end('ok');
      stderr.end();
      child.emit('close', 0);
    });
    return child;
  }) as typeof spawn);
}

/**
 * Run `body` with the Windows launch essentials stripped from `process.env`,
 * reproducing the env FLUJO's stdio boundary actually gives this server.
 */
async function withoutWindowsLaunchEssentials(body: () => Promise<void>): Promise<void> {
  const stripped = Object.keys(process.env).filter((key) =>
    ['comspec', 'windir', 'systemroot'].includes(key.toLowerCase()),
  );
  const saved = new Map(stripped.map((key) => [key, process.env[key]]));
  for (const key of stripped) delete process.env[key];
  _resetBashShellCacheForTests();
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetBashShellCacheForTests();
  }
}

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-bash-npm-env-'));
  mockedRoots.mockResolvedValue([tempRoot]);
});

afterEach(async () => {
  _resetBashSessionsForTests();
  _resetBashShellCacheForTests();
  mockedSpawn.mockClear();
  mockedRoots.mockReset();
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

describe('bash MCP server hands children a launchable Windows environment', () => {
  itOnWindows('supplies a real ComSpec even when its own env has none', async () => {
    await withoutWindowsLaunchEssentials(async () => {
      mockCompletedChild();
      await bashCallTool('run', { command: 'echo hi', cwd: tempRoot });

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
      const childEnv = (mockedSpawn.mock.calls[0]![2] as { env: Record<string, string> }).env;

      // Exactly one spelling, so Node's case-insensitive de-duplication cannot
      // settle on a blank variant, and it must point at a real interpreter.
      const comSpec = valuedSpellings(childEnv, 'ComSpec');
      expect(comSpec).toHaveLength(1);
      const interpreter = childEnv[comSpec[0]!]!;
      expect(fs.existsSync(interpreter)).toBe(true);
      expect(path.basename(interpreter).toLowerCase()).toBe('cmd.exe');

      // cmd.exe and most Windows toolchains also need these to initialise.
      expect(valuedSpellings(childEnv, 'SystemRoot')).toHaveLength(1);
      expect(valuedSpellings(childEnv, 'windir')).toHaveLength(1);
      expect(valuedSpellings(childEnv, 'PATHEXT')).toHaveLength(1);
    });
  });

  itOnWindows('never overwrites a ComSpec the caller asked for', async () => {
    mockCompletedChild();
    const chosen = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    await bashCallTool('run', {
      command: 'echo hi',
      cwd: tempRoot,
      env: { ComSpec: chosen },
    });

    const childEnv = (mockedSpawn.mock.calls[0]![2] as { env: Record<string, string> }).env;
    const comSpec = valuedSpellings(childEnv, 'ComSpec');
    expect(comSpec).toHaveLength(1);
    expect(childEnv[comSpec[0]!]).toBe(chosen);
  });

  itOnWindows('runs a real `npm run` script end to end', async () => {
    await fsp.writeFile(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({
        name: 'npm-run-env-fixture',
        version: '1.0.0',
        private: true,
        scripts: { hello: 'node -e "console.log(42 + 1)"' },
      }),
      'utf8',
    );

    await withoutWindowsLaunchEssentials(async () => {
      const result = parse(await bashCallTool('run', {
        command: 'npm run hello',
        cwd: tempRoot,
        timeout: 120,
      }));

      // Before the fix this was exit 1 with npm's banner and nothing else.
      expect(result.output).toContain('43');
      expect(result.exitCode).toBe(0);
    });
  }, 180_000);
});
