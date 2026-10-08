import contract from '@/shared/snapshotTransfer.json';

export const SNAPSHOT_ENCRYPTION = contract.snapshotEncryption;
export const SNAPSHOT_DEFAULT_LIMITS = contract.snapshotLimits;
export function getSnapshotLimits() {
  const configured = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) throw new Error('Snapshot limits are invalid.');
    return value;
  };
  const maxFileBytes = configured('FLUJO_SNAPSHOT_MAX_FILE_BYTES', SNAPSHOT_DEFAULT_LIMITS.maxFileBytes);
  const maxUncompressedBytes = configured('FLUJO_SNAPSHOT_MAX_BYTES', SNAPSHOT_DEFAULT_LIMITS.maxUncompressedBytes);
  const maxArchiveBytes = maxUncompressedBytes + SNAPSHOT_DEFAULT_LIMITS.maxManifestBytes;
  const maxEncryptedBytes = 4 * Math.ceil(maxArchiveBytes / 3) + 4096;
  if (!Number.isSafeInteger(maxArchiveBytes) || !Number.isSafeInteger(maxEncryptedBytes)) throw new Error('Snapshot limits are invalid.');
  return { ...SNAPSHOT_DEFAULT_LIMITS, maxFileBytes, maxUncompressedBytes, maxArchiveBytes, maxEncryptedBytes };
}
