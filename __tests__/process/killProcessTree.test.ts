/**
 * Unit test for the killProcessTree helper (issue #106).
 *
 * The tree-killing behavior itself is covered end-to-end by the `terminal` timeout
 * test (which spawns a real grandchild). Here we pin the spawn-failure contract: when
 * a child never produced a pid, the helper must be a safe no-op that returns a callable
 * cleanup and never throws.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  killProcessTree,
  killProcessTreeAndWait,
} from '@/utils/process/killProcessTree';

describe('killProcessTree', () => {
  it('is a safe no-op when child.pid is undefined (spawn failure)', () => {
    const fakeChild = { pid: undefined } as unknown as ChildProcess;

    let cleanup: (() => void) | undefined;
    expect(() => {
      cleanup = killProcessTree(fakeChild);
    }).not.toThrow();

    expect(typeof cleanup).toBe('function');
    expect(() => cleanup?.()).not.toThrow();
  });
});

describe('killProcessTreeAndWait', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', platformDescriptor!);
  });

  function runningChild(pid = 4242): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid,
      exitCode: null,
      signalCode: null,
    });
    return child;
  }

  it('sends SIGTERM then SIGKILL to the POSIX process group when the tree does not exit', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const child = runningChild();
    const pid = child.pid!;
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true as never);

    const result = await killProcessTreeAndWait(child, {
      graceMs: 5,
      finalWaitMs: 5,
    });

    expect(kill.mock.calls).toEqual([
      [-pid, 'SIGTERM'],
      [-pid, 'SIGKILL'],
    ]);
    expect(result).toMatchObject({ exited: false, forced: true, pid });
  });

  it('does not SIGKILL when the tree exits during the SIGTERM grace period', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const child = runningChild();
    const pid = child.pid!;
    const kill = jest.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGTERM') {
        setTimeout(() => {
          Object.assign(child, { exitCode: 0 });
          child.emit('exit', 0, null);
        }, 1);
      }
      return true;
    }) as never);

    const result = await killProcessTreeAndWait(child, {
      graceMs: 20,
      finalWaitMs: 5,
    });

    expect(kill.mock.calls).toEqual([[-pid, 'SIGTERM']]);
    expect(result).toMatchObject({ exited: true, forced: true, pid });
  });
});
