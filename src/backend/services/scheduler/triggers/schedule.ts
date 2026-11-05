import { Cron } from 'croner';
import { ScheduleTriggerConfig } from '@/shared/types/plannedExecution';
import { ArmedTrigger } from './types';

/**
 * Cron/interval trigger built on croner. Croner keeps the job in-process only
 * (nothing persisted), so missed-while-closed occurrences are naturally
 * skipped; the catch-up option is implemented by the scheduler service via the
 * persisted lastScheduledFireAt (see isCatchUpDue).
 */

/** Validate a cron pattern (+ timezone) without arming anything. */
export function validateSchedule(
  cron: string,
  timezone?: string
): { valid: boolean; error?: string } {
  try {
    // paused: never schedules a timer, just parses. Croner validates the
    // timezone lazily, so compute a next run to surface bad timezones too.
    const job = new Cron(cron, { timezone, paused: true });
    job.nextRun();
    job.stop();
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid cron pattern',
    };
  }
}

/** The next `count` fire times as ISO strings (for the UI preview). */
export function scheduleNextRuns(
  cron: string,
  timezone: string | undefined,
  count: number
): string[] {
  const job = new Cron(cron, { timezone, paused: true });
  try {
    return job.nextRuns(count).map(d => d.toISOString());
  } finally {
    job.stop();
  }
}

/**
 * True when a scheduled occurrence fell between the last recorded fire and
 * now — i.e. FLUJO was closed while a run was due and catch-up should run once.
 */
export function isCatchUpDue(
  config: ScheduleTriggerConfig,
  lastScheduledFireAt: string
): boolean {
  const job = new Cron(config.cron, { timezone: config.timezone, paused: true });
  try {
    const due = job.nextRun(new Date(lastScheduledFireAt));
    return due !== null && due.getTime() <= Date.now();
  } finally {
    job.stop();
  }
}

/**
 * Exact first occurrence after the persisted baseline, or null when none is
 * currently due. The scheduler uses this timestamp as a durable Persona
 * delivery identity; wall-clock startup time would change across retries.
 */
export function catchUpOccurrence(
  config: ScheduleTriggerConfig,
  lastScheduledFireAt: string,
  through: number = Date.now(),
): Date | null {
  const job = new Cron(config.cron, { timezone: config.timezone, paused: true });
  try {
    const due = job.nextRun(new Date(lastScheduledFireAt));
    return due !== null && due.getTime() <= through ? due : null;
  } finally {
    job.stop();
  }
}

export const MAX_CATCH_UP_LIMIT = 100;
/** A schedule every minute over a long outage must not mean an unbounded walk. */
const MAX_OCCURRENCES_SCANNED = 100_000;

export function validateCatchUpLimit(limit: unknown): string | undefined {
  if (limit === undefined) return undefined;
  return Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= MAX_CATCH_UP_LIMIT
    ? undefined
    : `catchUpLimit must be a whole number from 1 to ${MAX_CATCH_UP_LIMIT}`;
}

/**
 * Which missed occurrences to run, oldest first. With a limit of 1 this is exactly
 * catchUpOccurrence. With more, it is the newest `limit` ones, because after a long
 * outage recent work is the work still worth doing.
 */
export function catchUpOccurrences(
  config: ScheduleTriggerConfig,
  lastScheduledFireAt: string,
  through: number = Date.now(),
): Date[] {
  const limit = Math.min(Math.max(config.catchUpLimit ?? 1, 1), MAX_CATCH_UP_LIMIT);
  if (limit === 1) {
    const occurrence = catchUpOccurrence(config, lastScheduledFireAt, through);
    return occurrence ? [occurrence] : [];
  }
  const job = new Cron(config.cron, { timezone: config.timezone, paused: true });
  try {
    const newest: Date[] = [];
    let previous = new Date(lastScheduledFireAt);
    for (let scanned = 0; scanned < MAX_OCCURRENCES_SCANNED; scanned += 1) {
      const due = job.nextRun(previous);
      if (due === null || due.getTime() > through) break;
      newest.push(due);
      if (newest.length > limit) newest.shift();
      previous = due;
    }
    return newest;
  } finally {
    job.stop();
  }
}

/** Arm the cron job. Throws on an invalid pattern/timezone. */
export function armSchedule(
  config: ScheduleTriggerConfig,
  onFire: (occurrence: Date) => void | Promise<void>
): ArmedTrigger {
  let due: Date | null = null;
  const job = new Cron(
    config.cron,
    {
      timezone: config.timezone,
      // Don't keep the Node process alive just for schedules.
      unref: true,
    },
    (job) => {
      // Croner.currentRun() is callback wall time, which may be late. Retain
      // the intended occurrence for the persisted cursor and audit metadata.
      const occurrence = due ?? job.currentRun() ?? new Date();
      due = job.nextRun();
      return onFire(occurrence);
    }
  );
  due = job.nextRun();
  return {
    dispose: () => job.stop(),
    nextRun: () => job.nextRun()?.toISOString() ?? null,
  };
}
