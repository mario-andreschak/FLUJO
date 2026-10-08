export interface PersonaRecoveryBackupSummary {
  sourceWorkspace: string;
  captureId: string;
  capturedAt: number;
  archiveBytes: number;
  counts: Record<string, number>;
}

export interface PersonaRecoveryRestorePreview {
  sourceWorkspace: string;
  destinationWorkspace: string;
  captureId: string;
  capturedAt: number;
  archiveSha256: string;
  archiveBytes: number;
  previewToken: string;
  sourceCounts: Record<string, number>;
  restoredCounts: Record<string, number>;
  changes: Record<string, number>;
  requiredModelIds: string[];
  requiredAppNames: string[];
}
// The local Next.js proxy buffers at most 100 MiB (next.config.mjs). A backup
// larger than this could be downloaded but could not be uploaded intact.
export const PERSONA_RECOVERY_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
