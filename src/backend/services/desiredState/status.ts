/**
 * What an instance says about its desired state: versions, times and yes/no facts,
 * never content. Kept free of service imports so the operations status route, which
 * must stay cheap and must not start anything, can read it.
 */

export const DESIRED_STATE_STATUS_PATH = 'db/desired-state/status.json';

export type DesiredStateFailureCode =
  | 'invalid-file'
  | 'unreadable-file'
  | 'write-failed'
  | 'restore-failed'
  | 'version-reused'
  | 'nothing-to-roll-back-to';

export type InterruptedApply = 'none' | 'finished-at-restart' | 'restored-at-restart' | 'needs-attention';

export interface DesiredStateStatus {
  schemaVersion: 1;
  appliedVersion: string | null;
  appliedAt: string | null;
  lastAttemptAt: string | null;
  lastApplyFailed: boolean;
  lastFailureAt: string | null;
  lastFailureCode: DesiredStateFailureCode | null;
  interruptedApply: InterruptedApply;
  /** Rolled back from this version. The same file is not applied again by itself. */
  heldBackVersion: string | null;
  /** Managed objects someone changed by hand and the file's policy left alone. */
  localEditsKept: number;
  /** A change, such as network exposure, that takes effect only after a restart. */
  restartRequired: boolean;
}

export function emptyDesiredStateStatus(): DesiredStateStatus {
  return {
    schemaVersion: 1,
    appliedVersion: null,
    appliedAt: null,
    lastAttemptAt: null,
    lastApplyFailed: false,
    lastFailureAt: null,
    lastFailureCode: null,
    interruptedApply: 'none',
    heldBackVersion: null,
    localEditsKept: 0,
    restartRequired: false,
  };
}

const text = (value: unknown, limit = 128): string | null => (
  typeof value === 'string' && value.length <= limit ? value : null
);

/** Re-build every field, so whatever a stored file holds cannot reach a response. */
export function projectDesiredStateStatus(raw: unknown): DesiredStateStatus & { fileConfigured: boolean } {
  const fileConfigured = Boolean(process.env.FLUJO_DESIRED_STATE_FILE?.trim());
  const base = emptyDesiredStateStatus();
  if (!raw || typeof raw !== 'object') return { ...base, fileConfigured };
  const stored = raw as Record<string, unknown>;
  const count = stored.localEditsKept;
  return {
    ...base,
    fileConfigured,
    appliedVersion: text(stored.appliedVersion),
    appliedAt: text(stored.appliedAt, 40),
    lastAttemptAt: text(stored.lastAttemptAt, 40),
    lastApplyFailed: stored.lastApplyFailed === true,
    lastFailureAt: text(stored.lastFailureAt, 40),
    lastFailureCode: text(stored.lastFailureCode, 40) as DesiredStateFailureCode | null,
    interruptedApply: (['finished-at-restart', 'restored-at-restart', 'needs-attention'] as const)
      .find((value) => value === stored.interruptedApply) ?? 'none',
    heldBackVersion: text(stored.heldBackVersion),
    localEditsKept: Number.isSafeInteger(count) && (count as number) >= 0 ? (count as number) : 0,
    restartRequired: stored.restartRequired === true,
  };
}
