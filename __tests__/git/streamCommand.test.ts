import { installPrivateProfileFixture } from '../utils/privateProfileFixture';
let privateFixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
beforeEach(async () => { privateFixture = await installPrivateProfileFixture(); });
afterEach(async () => { await privateFixture?.restore(); });
/**
 * Regression test for the streaming Install / Build git actions (issue #65).
 *
 * The `installStream` / `buildStream` actions spawn the command asynchronously and
 * forward its stdout/stderr to the browser as NDJSON events while it runs, then emit a
 * terminal `result` whose `success` reflects the process exit code. This test drives the
 * route with a fake spawned process and asserts the streamed event sequence for both a
 * successful (exit 0) and a failing (exit 1) command.
 */

import os from 'os';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import type { CommandStreamEvent } from '@/shared/types/streaming';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

const spawnMock = jest.fn();
const execSyncMock = jest.fn();
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    execSync: (...args: unknown[]) => execSyncMock(...args),
  };
});

// The route imports simple-git at module load; it is not used by the streaming path.
jest.mock('simple-git', () => ({ __esModule: true, simpleGit: () => ({}) }));

import { POST } from '@/app/api/git/route';
import { createNdjsonParser } from '@/shared/utils/ndjson';

// Use a directory that actually exists so the route's fs.access(savePath) guard passes;
// spawn is mocked, so no real process runs in it.
const SAVE_PATH = os.tmpdir();

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

/** Configure spawn to emit a stdout + stderr chunk then close with `code`. */
function armSpawn(code: number) {
  spawnMock.mockImplementation(() => {
    const child = makeChild();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('added 5 packages\n'));
      child.stderr.emit('data', Buffer.from('npm warn deprecated foo@1\n'));
      child.emit('close', code);
    });
    return child;
  });
}

async function drain(res: Response): Promise<CommandStreamEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const parser = createNdjsonParser<CommandStreamEvent>();
  const events: CommandStreamEvent[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const e of parser.push(decoder.decode(value, { stream: true }))) events.push(e);
  }
  for (const e of parser.flush()) events.push(e);
  return events;
}

function request(body: unknown) {
  return {
    json: async () => body,
    signal: new AbortController().signal,
    // The route enforces the localhost origin guard (#131), which reads
    // request.headers.get('host'|'origin'); supply a localhost Host so this
    // streaming test exercises the real handler, not the 403 short-circuit.
    headers: new Headers({ host: 'localhost:4200' }),
  } as unknown as Parameters<typeof POST>[0];
}

describe('git route streaming Install/Build (#65)', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['install', 'build', 'installStream', 'buildStream'].flatMap(action =>
    ['stored profile', 'global policy'].map(mutation => [action, mutation]),
  ))('%s rechecks %s changed while filesystem access is paused', async (action, mutation) => {
    const envReplacement = jest.replaceProperty(process, 'env', {
      NODE_ENV: 'production', FLUJO_DATA_DIR: privateFixture.root,
    });
    const originalAccess = fs.access.bind(fs);
    let reachedPause!: () => void;
    let releasePause!: () => void;
    const paused = new Promise<void>(resolve => { reachedPause = resolve; });
    const resumed = new Promise<void>(resolve => { releasePause = resolve; });
    const accessSpy = jest.spyOn(fs, 'access').mockImplementation(async (file, mode) => {
      if (String(file) === SAVE_PATH) {
        reachedPause();
        await resumed;
      }
      return originalAccess(file, mode);
    });
    armSpawn(0);
    execSyncMock.mockReturnValue('build completed');
    const response = POST(request({
      action, savePath: SAVE_PATH, installCommand: 'npm install', buildCommand: 'npm run build',
    }));
    try {
      await paused;
      if (mutation === 'stored profile') {
        await saveItem(StorageKey.MCP_SERVERS, { changed: { rootPath: SAVE_PATH, isolation: {} } });
      } else {
        process.env.FLUJO_MCP_ISOLATION_FILE = '';
      }
      releasePause();
      const res = await response;
      if (action.endsWith('Stream')) {
        const events = await drain(res);
        expect(events[events.length - 1]).toEqual(expect.objectContaining({
          type: 'result', success: false,
          error: expect.stringMatching(/Host install\/build is not supported by runtime execution grants/),
        }));
      } else {
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: expect.stringMatching(/Host install\/build is not supported by runtime execution grants/),
        });
      }
      expect(execSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      releasePause();
      accessSpy.mockRestore();
      envReplacement.restore();
    }
  });

  it.each([
    ['FLUJO_OWNER_AUTH_FILE', ''], ['FLUJO_OWNER_AUTH_FILE', 'missing-synthetic-policy'],
    ['FLUJO_MCP_TRUSTED_HOST_FILE', ''], ['FLUJO_MCP_TRUSTED_HOST_FILE', 'missing-synthetic-policy'],
    ['FLUJO_MCP_ISOLATION_FILE', ''], ['FLUJO_MCP_ISOLATION_FILE', 'missing-synthetic-policy'],
    ['FLUJO_WORKER_MODE', '1'],
  ])('refuses every install/build variant before subprocesses for %s=%s', async (name, value) => {
    const envReplacement = jest.replaceProperty(process, 'env', {
      NODE_ENV: 'production', FLUJO_DATA_DIR: privateFixture.root, [name]: value,
    });
    try {
      for (const action of ['install', 'build', 'installStream', 'buildStream']) {
        const res = await POST(request({
          action, savePath: SAVE_PATH, installCommand: 'npm install', buildCommand: 'npm run build',
        }));
        if (name === 'FLUJO_OWNER_AUTH_FILE') {
          // The outer owner gate rejects invalid policy paths before the handler.
          expect(res.status).toBe(503);
          expect(await res.json()).toEqual({ error: 'Owner authentication is unavailable.', code: 'OWNER_AUTH_UNAVAILABLE' });
        } else if (name === 'FLUJO_WORKER_MODE') {
          expect(res.status).toBe(503);
          expect(await res.json()).toEqual({ error: 'Snapshot control plane is not configured.' });
        } else {
          expect(res.status).toBe(403);
          expect(await res.json()).toEqual({ error: expect.stringMatching(/Host install\/build is not supported by runtime execution grants/) });
        }
      }
      expect(spawnMock).not.toHaveBeenCalled();
      expect(execSyncMock).not.toHaveBeenCalled();
    } finally {
      envReplacement.restore();
    }
  });

  it.each([
    { isolation: null }, { isolation: {} }, { trustedHost: false }, { trustedHost: {} },
  ])('refuses stored profile selection without a host installer grant: %j', async selection => {
    await saveItem(StorageKey.MCP_SERVERS, { protectedServer: { rootPath: SAVE_PATH, ...selection } });
    for (const action of ['install', 'build', 'installStream', 'buildStream']) {
      const res = await POST(request({
        action, savePath: SAVE_PATH, installCommand: 'npm install', buildCommand: 'npm run build',
      }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: expect.stringMatching(/preinstalled immutable image/) });
    }
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('matches a protected stored working directory when building its source-tree parent', async () => {
    await saveItem(StorageKey.MCP_SERVERS, {
      protectedServer: { launch: { cwd: path.join(SAVE_PATH, 'synthetic-server-subdirectory') }, isolation: {} },
    });
    const res = await POST(request({ action: 'build', savePath: SAVE_PATH, buildCommand: 'npm run build' }));
    expect(res.status).toBe(403);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('refuses explicit malformed profile selection before storing a server', async () => {
    const res = await POST(request({
      action: 'installStream', savePath: SAVE_PATH, installCommand: 'npm install', trustedHost: false,
    }));
    expect(res.status).toBe(403);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['install', 'installCommand', 'npm install'],
    ['build', 'buildCommand', 'npm run build'],
    ['installStream', 'installCommand', 'npm install'],
    ['buildStream', 'buildCommand', 'npm run build'],
  ])('%s scopes host credentials while preserving explicit server environment', async (action, commandKey, command) => {
    const envReplacement = jest.replaceProperty(process, 'env', {
      NODE_ENV: 'production',
      FLUJO_DATA_DIR: privateFixture.root,
      PATH: 'synthetic-installer-path',
      HOME: 'synthetic-installer-home',
      OPENAI_API_KEY: 'synthetic-host-provider-secret',
      FLUJO_API_KEY: 'synthetic-host-flujo-secret',
      NODE_OPTIONS: '--require synthetic-loader',
      NPM_CONFIG_USERCONFIG: 'synthetic-host-auth-config',
      npm_config_registry: 'https://synthetic-host-registry.invalid',
    });
    const explicitEnv = {
      SERVER_ACCESS_TOKEN: 'synthetic-explicit-server-secret',
      LOG_LEVEL: 'debug',
      NPM_CONFIG_INCLUDE: 'optional',
    };
    try {
      armSpawn(0);
      execSyncMock.mockReturnValue('build completed');
      const res = await POST(request({
        action, savePath: SAVE_PATH, [commandKey]: command, env: explicitEnv,
      }));
      const isStream = action.endsWith('Stream');
      if (isStream) {
        const events = await drain(res);
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ type: 'result', success: true }));
      } else {
        expect(await res.json()).toEqual(expect.objectContaining({ success: true }));
      }
      const commandMock = isStream ? spawnMock : execSyncMock;
      expect(commandMock).toHaveBeenCalledTimes(1);
      expect(commandMock.mock.calls[0][1].env).toEqual({
        NODE_ENV: 'production',
        PATH: 'synthetic-installer-path',
        HOME: 'synthetic-installer-home',
        SERVER_ACCESS_TOKEN: 'synthetic-explicit-server-secret',
        LOG_LEVEL: 'debug',
        npm_config_include: 'dev',
      });
      expect(explicitEnv.NPM_CONFIG_INCLUDE).toBe('optional');
    } finally {
      envReplacement.restore();
    }
  });

  it('installStream forwards stdout/stderr live and reports success on exit 0', async () => {
    armSpawn(0);
    const res = await POST(request({ action: 'installStream', savePath: SAVE_PATH, installCommand: 'npm install' }));
    const events = await drain(res);

    expect(events).toContainEqual({ type: 'stdout', data: 'added 5 packages\n' });
    expect(events).toContainEqual({ type: 'stderr', data: 'npm warn deprecated foo@1\n' });

    const result = events[events.length - 1] as Extract<CommandStreamEvent, { type: 'result' }>;
    expect(result.type).toBe('result');
    expect(result.success).toBe(true);
    // The buffered commandOutput mirrors what the non-streaming path returned.
    expect(result.commandOutput).toContain('added 5 packages');
    expect(result.commandOutput).toContain('npm warn deprecated');

    // shell:true is preserved so compound user commands keep working.
    expect(spawnMock).toHaveBeenCalledWith('npm install', expect.objectContaining({ shell: true }));
    expect(spawnMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      env: expect.objectContaining({ npm_config_include: 'dev' }),
    }));
  });

  it('buildStream reports failure (success:false) on a non-zero exit code', async () => {
    armSpawn(1);
    const res = await POST(request({ action: 'buildStream', savePath: SAVE_PATH, buildCommand: 'npm run build' }));
    const events = await drain(res);

    const result = events[events.length - 1] as Extract<CommandStreamEvent, { type: 'result' }>;
    expect(result.type).toBe('result');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exit code 1/);
  });
});
