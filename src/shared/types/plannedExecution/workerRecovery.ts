export type WorkerRecoveryReason =
  | 'worker-not-ready' | 'recovery-not-configured' | 'no-local-provenance' | 'invalid-provenance'
  | 'worker-authority-changed' | 'generation-changed' | 'definition-changed'
  | 'not-opted-in' | 'unsupported-plan' | 'paused' | 'disabled'
  | 'retired' | 'unresolved-admission' | 'already-accounted' | 'eligible';

/** Arming and intent observations only; no successful-effect/process-exit claim. */
export interface WorkerRecoveryStatus {
  state: 'suppressed' | 'pending-local-recovery' | 'armed' | 'rejected';
  reason: WorkerRecoveryReason;
  eligible: boolean;
  definitionSha256: string;
  pending?: { runId: string; occurrenceAt: string };
}
