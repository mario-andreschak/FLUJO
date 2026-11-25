import { SIGN_IN_DELAY_FIRST_MS, SIGN_IN_DELAY_MAX_MS } from '@/shared/types/accounts';

/**
 * Slows down guessing passwords (#574). After a failed sign-in for a name, the
 * next try for that name must wait: 1 second, then twice as long after every
 * further failure, never more than 15 minutes.
 *
 * It heals by itself and is never a lockout: a successful sign-in clears the
 * name, a restart clears everything, and a name that stays quiet for 15
 * minutes after its wait ended is forgotten. Unknown names are slowed down the
 * same way, so the waits do not reveal which names exist.
 */

interface Entry { failures: number; until: number }

const entries = new Map<string, Entry>();
/** Above this many remembered names, every new failure first forgets the quiet ones. */
const SWEEP_ABOVE = 1_000;

function key(name: string): string {
  return name.trim().toLowerCase();
}

function stale(entry: Entry, now: number): boolean {
  return now >= entry.until + SIGN_IN_DELAY_MAX_MS;
}

/** How long this name must still wait before the next try, in milliseconds (0 = may try now). */
export function signInWaitMs(name: string, now = Date.now()): number {
  const entry = entries.get(key(name));
  if (!entry) return 0;
  if (stale(entry, now)) {
    entries.delete(key(name));
    return 0;
  }
  return Math.max(0, entry.until - now);
}

/** Remember a failed sign-in and return the wait before the next try. */
export function recordFailedSignIn(name: string, now = Date.now()): number {
  if (entries.size > SWEEP_ABOVE) {
    for (const [candidate, entry] of entries) if (stale(entry, now)) entries.delete(candidate);
  }
  const previous = entries.get(key(name));
  const failures = previous && !stale(previous, now) ? previous.failures + 1 : 1;
  const wait = Math.min(SIGN_IN_DELAY_MAX_MS, SIGN_IN_DELAY_FIRST_MS * 2 ** Math.min(failures - 1, 30));
  entries.set(key(name), { failures, until: now + wait });
  return wait;
}

export function recordSuccessfulSignIn(name: string): void {
  entries.delete(key(name));
}

/** Tests only. */
export function resetSignInThrottle(): void {
  entries.clear();
}
