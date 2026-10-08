import {
  DEFAULT_SNAPSHOT_RETENTION_POLICY,
  isSnapshotRetentionPolicy,
} from '@/shared/types/snapshot';

describe('snapshot retention policy', () => {
  it('accepts the bounded default policy', () => {
    expect(isSnapshotRetentionPolicy(DEFAULT_SNAPSHOT_RETENTION_POLICY)).toBe(true);
  });

  it('rejects malformed, negative, and non-integral limits before persistence', () => {
    expect(isSnapshotRetentionPolicy({
      ...DEFAULT_SNAPSHOT_RETENTION_POLICY,
      maxBytes: -1,
    })).toBe(false);
    expect(isSnapshotRetentionPolicy({
      ...DEFAULT_SNAPSHOT_RETENTION_POLICY,
      maxAgeMs: 1.5,
    })).toBe(false);
    expect(isSnapshotRetentionPolicy({
      ...DEFAULT_SNAPSHOT_RETENTION_POLICY,
      automaticCleanup: 'yes',
    })).toBe(false);
  });
});
