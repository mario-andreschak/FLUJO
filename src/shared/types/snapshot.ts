/** Workspace-scoped filesystem snapshot retention contract (issue #414). */
export const SNAPSHOT_POLICY_VERSION = 1 as const;

export interface SnapshotRetentionPolicy {
  version: typeof SNAPSHOT_POLICY_VERSION;
  /** Retention can be disabled without disabling capture. */
  enabled: boolean;
  /** Maximum snapshot-store bytes for this workspace. */
  maxBytes: number;
  /** Maximum age of a capture in milliseconds. */
  maxAgeMs: number;
  /** Maximum retained captures for each shadow repository. */
  maxCapturesPerRoot: number;
  /** Allow maintenance after capture; explicit cleanup remains available. */
  automaticCleanup: boolean;
}

/** Bounded defaults for newly persisted policies. */
export const DEFAULT_SNAPSHOT_RETENTION_POLICY: SnapshotRetentionPolicy = {
  version: SNAPSHOT_POLICY_VERSION,
  enabled: true,
  maxBytes: 5 * 1024 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxCapturesPerRoot: 100,
  automaticCleanup: true,
};

export type SnapshotHealth = 'healthy' | 'missing' | 'corrupt' | 'unreadable';

export interface SnapshotRepositoryUsage {
  /** Stable opaque id; never a host path. */
  id: string;
  /** Safe label that does not disclose a host path. */
  label: string;
  logicalBytes: number;
  onDiskBytes: number;
  commitCount: number;
  oldestCaptureAt?: string;
  newestCaptureAt?: string;
  health: SnapshotHealth;
}

export interface SnapshotUsage {
  logicalBytes: number;
  onDiskBytes: number;
  repositoryCount: number;
  repositories: SnapshotRepositoryUsage[];
  lastCleanupAt?: string;
}

export interface SnapshotActivity {
  capture: boolean;
  cleanup: boolean;
  revert: boolean;
  migration: boolean;
  /** A storage-mutating capture, cleanup, revert, or migration is active. */
  storageBusy: boolean;
  operatorDisabled: boolean;
  /** New captures pause while retention cannot make the store safe. */
  captureSuspended: boolean;
  localFolderAccess: boolean;
}

export interface SnapshotStatus {
  policy: SnapshotRetentionPolicy;
  usage: SnapshotUsage;
  activity: SnapshotActivity;
  /** Path-free capability flag for the server's current operating system. */
  localFolderAccessSupported: boolean;
  overBudget: boolean;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

export function isSnapshotRetentionPolicy(value: unknown): value is SnapshotRetentionPolicy {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Record<string, unknown>;
  return policy.version === SNAPSHOT_POLICY_VERSION
    && typeof policy.enabled === 'boolean'
    && isNonNegativeSafeInteger(policy.maxBytes)
    && isNonNegativeSafeInteger(policy.maxAgeMs)
    && isNonNegativeSafeInteger(policy.maxCapturesPerRoot)
    && typeof policy.automaticCleanup === 'boolean';
}
