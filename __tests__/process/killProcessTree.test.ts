/**
 * Unit test for the killProcessTree helper (issue #106).
 *
 * The tree-killing behavior itself is covered end-to-end by the `terminal` timeout
 * test (which spawns a real grandchild). Here we pin the spawn-failure contract: when
 * a child never produced a pid, the helper must be a safe no-op that returns a callable
 * cleanup and never throws.
 */

import type { ChildProcess } from 'child_process';
import { killProcessTree } from '@/utils/process/killProcessTree';

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
