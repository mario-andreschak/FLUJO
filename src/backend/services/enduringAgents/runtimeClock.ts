import { performance } from 'perf_hooks';

export interface PersonaRuntimeTimer {
  clear(): void;
  unref(): void;
}

export interface PersonaRuntimeClock {
  /** Wall-clock milliseconds used for persisted timestamps and expiry checks. */
  now(): number;
  /** Monotonic milliseconds used for elapsed-time measurements. */
  monotonicNow(): number;
  /** Schedule a callback without exposing a platform-specific timer handle. */
  setTimer(fn: () => void, ms: number): PersonaRuntimeTimer;
  /** Sleep for the requested duration. */
  sleep(ms: number): Promise<void>;
}

const systemClock: PersonaRuntimeClock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimer(fn, ms) {
    const timer = setTimeout(fn, ms);
    return {
      clear: () => clearTimeout(timer),
      unref: () => timer.unref?.(),
    };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let activeClock: PersonaRuntimeClock = systemClock;

// The stable facade means modules may safely cache getPersonaRuntimeClock()
// while tests can still replace the process-local delegate after import.
const facade: PersonaRuntimeClock = {
  now: () => activeClock.now(),
  monotonicNow: () => activeClock.monotonicNow(),
  setTimer: (fn, ms) => activeClock.setTimer(fn, ms),
  sleep: (ms) => activeClock.sleep(ms),
};

export function getPersonaRuntimeClock(): PersonaRuntimeClock {
  return facade;
}

/** Test-only process-local clock seam. Returns the previous delegate. */
export function _setPersonaRuntimeClockForTests(
  clock: PersonaRuntimeClock | undefined,
): PersonaRuntimeClock | undefined {
  const previous = activeClock === systemClock ? undefined : activeClock;
  activeClock = clock ?? systemClock;
  return previous;
}
