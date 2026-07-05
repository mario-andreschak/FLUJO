/**
 * A trigger that has been armed for an enabled PlannedExecution. The scheduler
 * keeps one per execution and disposes it on reconcile/disable/delete.
 */
export interface ArmedTrigger {
  dispose(): void;
  /** Next fire time as ISO string, when the trigger type can know it. */
  nextRun?(): string | null;
}
