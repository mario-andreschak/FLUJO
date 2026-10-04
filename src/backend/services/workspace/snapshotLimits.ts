export const SNAPSHOT_MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
// ZIP32 reserves 0xffff as the ZIP64 sentinel, which this restore rejects.
export const SNAPSHOT_MAX_MEMBERS = 65_534;

export function encryptedSnapshotSizeLimit(maxArchiveBytes: number): number {
  const limit = 4 * Math.ceil(maxArchiveBytes / 3) + 4096;
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 0 || !Number.isSafeInteger(limit)) {
    throw new Error('Snapshot limits configuration is invalid.');
  }
  return limit;
}

export interface SnapshotLimits {
  maxFileBytes: number;
  maxUncompressedBytes: number;
  maxManifestBytes: typeof SNAPSHOT_MAX_MANIFEST_BYTES;
  maxArchiveBytes: number;
  maxEncryptedBytes: number;
  maxMembers: typeof SNAPSHOT_MAX_MEMBERS;
}

function configuredLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Shared acceptance limits; these do not bound every allocation before validation. */
export function getSnapshotLimits(): SnapshotLimits {
  const maxFileBytes = configuredLimit('FLUJO_SNAPSHOT_MAX_FILE_BYTES', 256 * 1024 * 1024);
  const maxUncompressedBytes = configuredLimit('FLUJO_SNAPSHOT_MAX_BYTES', 1024 * 1024 * 1024);
  const maxArchiveBytes = maxUncompressedBytes + SNAPSHOT_MAX_MANIFEST_BYTES;
  return { maxFileBytes, maxUncompressedBytes, maxManifestBytes: SNAPSHOT_MAX_MANIFEST_BYTES,
    maxArchiveBytes, maxEncryptedBytes: encryptedSnapshotSizeLimit(maxArchiveBytes), maxMembers: SNAPSHOT_MAX_MEMBERS };
}
