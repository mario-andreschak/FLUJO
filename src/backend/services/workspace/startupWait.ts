/**
 * A request that arrives while FLUJO is still starting waits for startup
 * instead of being refused at once (#757, resilience over refusal). Startup
 * steps call `startupChanged()` whenever their state moves; each waiter then
 * re-checks its own condition. A waiter also re-checks every second, so a
 * missed change never strands it, and it gives up at its deadline or when its
 * caller hangs up. The caller then answers with the usual retryable 503.
 */

/** How long a request waits for FLUJO to finish starting before it gets the usual 503. */
export const STARTUP_WAIT_MS = 60_000;
const RECHECK_MS = 1_000;

export interface StartupWait {
  /** `Date.now()` value after which the caller stops waiting. */
  deadline: number;
  signal?: AbortSignal;
}

declare global {
  // Several Next bundles load this module; startup and requests must share one set.
  var __flujoStartupWaiters: Set<() => void> | undefined;
}
const waiters = globalThis.__flujoStartupWaiters ??= new Set();

/** A startup step moved on: let every waiter look again. */
export function startupChanged(): void {
  for (const wake of [...waiters]) wake();
}

/** A wait for a request that arrives now and may hold until FLUJO has started. */
export function startupWaitFor(request: { signal?: AbortSignal }, waitMs: number = STARTUP_WAIT_MS): StartupWait {
  return { deadline: Date.now() + waitMs, signal: request.signal };
}

/** Resolves true once `ready()` holds, or false at the deadline or when the caller hangs up. */
export async function waitForStartup(ready: () => boolean, wait: StartupWait): Promise<boolean> {
  while (!ready()) {
    const remaining = wait.deadline - Date.now();
    if (remaining <= 0 || wait.signal?.aborted) return false;
    await new Promise<void>(resolve => {
      const done = () => {
        waiters.delete(done);
        clearTimeout(timer);
        wait.signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(remaining, RECHECK_MS));
      waiters.add(done);
      wait.signal?.addEventListener('abort', done, { once: true });
    });
  }
  return true;
}
