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
import type { CommandStreamEvent } from '@/shared/types/streaming';

const spawnMock = jest.fn();
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

// The route imports simple-git at module load; it is not used by the streaming path.
jest.mock('simple-git', () => ({ __esModule: true, default: () => ({}) }));

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
  } as unknown as Parameters<typeof POST>[0];
}

describe('git route streaming Install/Build (#65)', () => {
  beforeEach(() => jest.clearAllMocks());

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
