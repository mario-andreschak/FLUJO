/**
 * Tests for the file-watch trigger: the glob matcher (pure) and the chokidar
 * watcher behavior (real filesystem in a temp dir) — event filtering, burst
 * batching into one fire, and dispose.
 */
import os from 'os';
import path from 'path';
import { promises as fs, realpathSync } from 'fs';
import {
  armFileWatch,
  globToRegExp,
} from '@/backend/services/scheduler/triggers/fileWatch';
import type { FileWatchFire } from '@/backend/services/scheduler/triggers/fileWatch';

describe('globToRegExp', () => {
  it.each([
    ['*.pdf', 'report.pdf', true],
    ['*.pdf', 'report.txt', false],
    ['*.pdf', 'nested/report.pdf', false], // * does not cross folders
    ['**/*.csv', 'a/b/data.csv', true],
    ['**/*.csv', 'data.csv', true], // **/ matches zero directories
    ['reports/**/*.csv', 'reports/2026/q1.csv', true],
    ['reports/**/*.csv', 'other/2026/q1.csv', false],
    ['file-?.txt', 'file-1.txt', true],
    ['file-?.txt', 'file-10.txt', false],
    ['data.(1)', 'data.(1)', true], // regex metachars are escaped
  ])('%s vs %s → %s', (glob, candidate, expected) => {
    expect(globToRegExp(glob).test(candidate)).toBe(expected);
  });
});

describe('armFileWatch', () => {
  let dir: string;
  const triggers: Array<{ dispose(): void }> = [];

  beforeEach(async () => {
    // realpath the temp dir: os.tmpdir() can be an 8.3 short path on Windows,
    // and event paths come back long-form (armFileWatch resolves internally
    // too; this keeps the test's expected paths comparable).
    dir = realpathSync.native(
      await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-watch-test-'))
    );
  });

  afterEach(async () => {
    for (const trigger of triggers.splice(0)) {
      trigger.dispose();
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const arm = (
    overrides: Partial<Parameters<typeof armFileWatch>[0]> = {},
    onFire: (payload: FileWatchFire) => void,
    onError: (message: string) => void = () => undefined
  ) => {
    const trigger = armFileWatch(
      {
        type: 'file-watch',
        path: dir,
        events: ['add', 'change'],
        // Short quiet window so tests stay fast; awaitWriteFinish still adds
        // its 500ms stability threshold on top.
        debounceMs: 300,
        ...overrides,
      },
      onFire,
      onError
    );
    triggers.push(trigger);
    return trigger;
  };

  const waitFor = async (condition: () => boolean, timeoutMs = 8000) => {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for watcher');
      }
      await new Promise(r => setTimeout(r, 50));
    }
  };

  it('batches a burst of new files into a single fire', async () => {
    const fires: FileWatchFire[] = [];
    arm({}, payload => fires.push(payload));
    // Give the watcher a moment to be ready before producing events.
    await new Promise(r => setTimeout(r, 300));

    await fs.writeFile(path.join(dir, 'one.txt'), 'a');
    await fs.writeFile(path.join(dir, 'two.txt'), 'b');

    await waitFor(() => fires.length > 0);
    // One batched fire containing both adds (not one fire per file).
    expect(fires).toHaveLength(1);
    const events = fires[0].events.map(e => path.basename(e.path)).sort();
    expect(events).toEqual(['one.txt', 'two.txt']);
    expect(fires[0].events.every(e => e.event === 'add')).toBe(true);
  });

  it('ignores events outside the configured kinds and glob', async () => {
    const fires: FileWatchFire[] = [];
    arm({ events: ['unlink'], glob: '*.txt' }, payload => fires.push(payload));
    await new Promise(r => setTimeout(r, 300));

    // 'add' events (wrong kind) and a non-matching deletion must not fire.
    await fs.writeFile(path.join(dir, 'kept.txt'), 'a');
    await fs.writeFile(path.join(dir, 'other.log'), 'b');
    await new Promise(r => setTimeout(r, 1200));
    await fs.unlink(path.join(dir, 'other.log'));
    await new Promise(r => setTimeout(r, 1200));
    expect(fires).toHaveLength(0);

    // A matching deletion fires.
    await fs.unlink(path.join(dir, 'kept.txt'));
    await waitFor(() => fires.length > 0);
    expect(fires[0].events).toEqual([
      { event: 'unlink', path: path.join(dir, 'kept.txt') },
    ]);
  });

  it('stops firing after dispose', async () => {
    const fires: FileWatchFire[] = [];
    const trigger = arm({}, payload => fires.push(payload));
    await new Promise(r => setTimeout(r, 300));

    trigger.dispose();
    await fs.writeFile(path.join(dir, 'late.txt'), 'a');
    await new Promise(r => setTimeout(r, 1500));
    expect(fires).toHaveLength(0);
  });
});
