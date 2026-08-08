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

/**
 * Wait for a child process to exit, up to timeoutMs.
 * Resolves true if the process exited (or had already exited), false on timeout.
 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

/** Outcome of an awaited descendant-aware termination (issue #413). */
export interface KillTreeResult {
  /** The child (and, as far as the OS reports, its group/tree) has exited. */
  exited: boolean;
  /** True when termination required a signal/taskkill rather than a voluntary exit. */
  forced: boolean;
  /** How long the whole escalation took, in ms. */
  durationMs: number;
  /** The pid we escalated against, when the child ever had one. */
  pid?: number;
}

/**
 * Descendant-aware termination that is AWAITABLE and VERIFIES exit (issue #413).
 *
 * `killProcessTree` is fire-and-forget: it signals the tree and returns a timer
 * canceller, so a caller cannot tell whether the tree actually died before it
 * replaces the connection / releases the port / declares shutdown complete. That
 * ambiguity is exactly what let a replacement MCP connection race a
 * still-running predecessor and what let "shutdown" return while grandchildren
 * were still alive.
 *
 * Sequence: tree-kill (taskkill /T /F on Windows, negative-pid SIGTERM on POSIX)
 * -> wait `graceMs` -> negative-pid SIGKILL on POSIX (Windows /F is already
 * final) -> wait `finalWaitMs`. Never throws: ESRCH ("already gone") and a
 * failed `taskkill` spawn are both success-by-another-name.
 */
export async function killProcessTreeAndWait(
  child: ChildProcess,
  options?: { graceMs?: number; finalWaitMs?: number },
): Promise<KillTreeResult> {
  const startedAt = Date.now();
  const graceMs = options?.graceMs ?? 2000;
  const finalWaitMs = options?.finalWaitMs ?? 2000;
  const pid = child.pid;

  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, forced: false, durationMs: Date.now() - startedAt, pid };
  }
  if (pid === undefined) {
    // spawn failed or never produced a pid — there is no tree to terminate.
    return { exited: true, forced: false, durationMs: Date.now() - startedAt };
  }

  // First escalation: signal the whole tree/group, not just the shell wrapper.
  const cancelEscalation = killProcessTree(child, graceMs);
  let exited = await waitForExit(child, graceMs);
  if (exited) {
    // The tree died within the grace window; drop the pending SIGKILL so it can
    // neither hit a recycled pid nor keep a timer referenced.
    cancelEscalation();
    return { exited: true, forced: true, durationMs: Date.now() - startedAt, pid };
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* ESRCH: the group is already gone */
    }
  }
  cancelEscalation();
  exited = await waitForExit(child, finalWaitMs);
  if (!exited) {
    log.warn(`Process tree for pid ${pid} did not exit after forced escalation`);
  }
  return { exited, forced: true, durationMs: Date.now() - startedAt, pid };
}
