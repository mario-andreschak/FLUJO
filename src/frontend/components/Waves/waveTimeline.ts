/**
 * Pure timeline helpers for the Waves canvas (#144).
 *
 * The canvas reads as a TIMELINE: a clock/orb is anchored on the left and each
 * scheduled run travels right→left as its fire time approaches "now". Zooming
 * the window out (1h → 6h → 1d) reveals more upcoming runs of a recurring
 * schedule, each rendered as its own root instance with its own chain.
 *
 * These functions perform NO I/O and no React work so they can be unit-tested
 * in isolation. `croner` is isomorphic (already a runtime dependency used by the
 * scheduler) and is safe to bundle in the browser.
 */

import { Cron } from 'croner';

/** Selectable look-ahead windows for the timeline. */
export type WaveWindowKey = '1h' | '6h' | '1d';

/** Window key → milliseconds. */
export const WAVE_WINDOWS: Record<WaveWindowKey, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

export const WAVE_WINDOW_KEYS: WaveWindowKey[] = ['1h', '6h', '1d'];

/** Default window when a wave first renders. */
export const DEFAULT_WAVE_WINDOW: WaveWindowKey = '6h';

/**
 * Hard cap on how many upcoming occurrences of a single recurring root we render
 * inside a window. Prevents a 5-second cron from exploding the node count while
 * still comfortably covering "24 runs of a 60-min job across 1 day".
 */
export const MAX_OCCURRENCES = 24;

/**
 * Enumerate the upcoming fire timestamps (ms) of a cron pattern that fall inside
 * `[from, from + windowMs]`, capped at `cap`. Returns an empty array for an
 * absent/blank/invalid pattern (the caller then falls back to a single instance
 * at the live `nextRun`). Deterministic for a fixed `from`.
 */
export function enumerateOccurrences(
  cron: string | undefined | null,
  from: number,
  windowMs: number,
  cap: number = MAX_OCCURRENCES,
  timezone?: string,
): number[] {
  if (!cron || typeof cron !== 'string' || !cron.trim()) return [];
  if (!Number.isFinite(from) || !Number.isFinite(windowMs) || windowMs <= 0) return [];
  const end = from + windowMs;
  const out: number[] = [];
  try {
    const job = timezone ? new Cron(cron.trim(), { timezone }) : new Cron(cron.trim());
    // croner's nextRun(prev) returns the first run strictly AFTER prev.
    let cursor: Date | null = new Date(from - 1);
    for (let i = 0; i < cap; i++) {
      const next: Date | null = job.nextRun(cursor);
      if (!next) break;
      const t = next.getTime();
      if (t > end) break;
      out.push(t);
      cursor = next;
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * Map a future timestamp to a horizontal fraction in `[0, 1]` across the window:
 * 0 = due now (far left, next to the clock), 1 = a full window away (far right).
 * A run that is already due (or in the past) clamps to 0.
 */
export function timelineFraction(runAt: number | null, now: number, windowMs: number): number {
  if (runAt == null || !Number.isFinite(runAt) || windowMs <= 0) return 0;
  const remaining = runAt - now;
  if (remaining <= 0) return 0;
  return Math.min(1, remaining / windowMs);
}

/** Compact "in 2h 05m" / "due now" label for a future timestamp. */
export function formatIn(runAt: number | null, now: number): string {
  if (runAt == null || !Number.isFinite(runAt)) return 'no scheduled run';
  const diff = runAt - now;
  if (diff <= 0) return 'due now';
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `in ${minutes}m`;
}
