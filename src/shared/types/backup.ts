export interface RestoreSelectionResult {
  /** Successfully written records or files, not merely attempted operations. */
  restored: number;
  /** Failed/skipped entries, plus markers for data omitted by a partial export. */
  failed: number;
}

export interface RestoreResponse {
  success: boolean;
  status?: 'complete' | 'partial' | 'failed' | 'empty';
  selectionResults?: Record<string, RestoreSelectionResult>;
  error?: string;
}
