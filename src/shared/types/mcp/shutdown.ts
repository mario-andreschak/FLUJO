/** Redacted close observation; connection/configuration state is separate. */
export interface MCPShutdownObservation {
  processOwnership: 'owned' | 'external' | 'unknown';
  exitOutcome: 'observed_exit' | 'unknown' | 'not_applicable';
  forced: boolean;
  errorClassification: 'none' | 'close_failed' | 'exit_unobserved';
}

/** One process-local observation for one workspace/server runtime generation. */
export interface MCPShutdownReceipt extends MCPShutdownObservation {
  schemaVersion: 1;
  runtimeId: string;
  workspace: string;
  serverName: string;
  generation: number;
  observedAt: string;
  durationMs: number;
}
