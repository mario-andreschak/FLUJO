import { spawn, type ChildProcess } from 'child_process';
import { createLogger } from '@/utils/logger';

const log = createLogger('utils/process/killProcessTree');

/**
 * Terminate a shell-wrapped child process AND its entire subtree, cross-platform.
 *
 * A command spawned with `shell: true` has the shell wrapper (`cmd.exe` / `/bin/sh`)
 * as its immediate child, so `child.kill()` only signals that wrapper and leaves
 * everything the shell launched running as orphans. This kills the whole tree:
 *
 *  - **Windows:** `taskkill /pid <pid> /T /F` walks the process tree and force-kills it.
 *  - **POSIX:**   signals the child's PROCESS GROUP (negative pid). This requires the
 *                 child to have been spawned with `detached: true` so it is the group
 *                 leader; then `SIGTERM` reaches every descendant, escalating to
 *                 `SIGKILL` after a short grace window if the group is still alive.
 *
 * @returns a cleanup function that clears the pending SIGKILL escalation timer. Call it
 *          from the child's `close`/`exit` handler so a promptly-exiting group does not
 *          later receive a dangling SIGKILL (and the timer never keeps the event loop
 *          alive). On Windows / spawn-failure it is a harmless no-op.
 */
export function killProcessTree(child: ChildProcess, graceMs = 2000): () => void {
  const pid = child.pid;
  if (pid === undefined) {
    // spawn failed or never produced a pid — nothing to terminate.
    return () => { /* no-op */ };
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
      // The target may already be gone; never let taskkill's own failure surface.
      killer.on('error', (err) => log.debug(`taskkill failed for pid ${pid}: ${err.message}`));
    } catch (err) {
      log.debug(`taskkill spawn threw for pid ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return () => { /* no escalation timer on Windows */ };
  }

  // POSIX: signal the whole process group (leader was spawned detached), so every
  // descendant of the shell wrapper is terminated, not just the wrapper itself.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* ESRCH: the group is already gone */
  }

  const escalation = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, graceMs);
  // Don't let the escalation backstop keep the process alive on its own.
  escalation.unref?.();

  return () => clearTimeout(escalation);
}
