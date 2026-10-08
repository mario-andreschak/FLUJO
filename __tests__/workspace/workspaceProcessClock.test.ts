import {
  withWorkspaceProcessMutation, withWorkspaceProcessSnapshot,
} from '@/backend/services/enduringAgents/runtimeLock';
import { _setPersonaRuntimeClockForTests } from '@/backend/services/enduringAgents/runtimeClock';
import { runWithWorkspace } from '@/utils/workspace';

jest.setTimeout(30_000);

it('drains contended filesystem writers and enforces capture deadlines while the actor clock is paused', async () => {
  const actorSleep = jest.fn(() => new Promise<void>(() => undefined));
  const previous = _setPersonaRuntimeClockForTests({
    now: () => 1, monotonicNow: () => 0, sleep: actorSleep,
    setTimer: () => { throw new Error('Filesystem locks must not schedule actor timers.'); },
  });
  try {
    await runWithWorkspace(`paused-lock-clock-${process.pid}`, async () => {
      // Concurrent registration contends on the same admission file. A virtual
      // sleep would never settle without someone advancing the actor clock.
      expect(await Promise.all(Array.from({ length: 8 }, (_, index) => (
        withWorkspaceProcessMutation(async () => index)
      )))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const writer = withWorkspaceProcessMutation(async () => { entered(); await held; });
      await ready;
      try {
        await expect(withWorkspaceProcessSnapshot(async () => 'must not capture', { timeoutMs: 100 }))
          .rejects.toThrow('Timed out');
      } finally {
        release();
        await writer;
      }
      await expect(withWorkspaceProcessSnapshot(async () => 'captured')).resolves.toBe('captured');
      expect(actorSleep).not.toHaveBeenCalled();
    });
  } finally {
    _setPersonaRuntimeClockForTests(previous);
  }
});
