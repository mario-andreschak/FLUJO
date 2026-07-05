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

/** Arm the cron job. Throws on an invalid pattern/timezone. */
export function armSchedule(
  config: ScheduleTriggerConfig,
  onFire: () => void
): ArmedTrigger {
  const job = new Cron(
    config.cron,
    {
      timezone: config.timezone,
      // Don't keep the Node process alive just for schedules.
      unref: true,
    },
    onFire
  );
  return {
    dispose: () => job.stop(),
    nextRun: () => job.nextRun()?.toISOString() ?? null,
  };
}
