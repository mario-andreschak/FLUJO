/**
 * A trigger that has been armed for an enabled PlannedExecution. The scheduler
 * keeps one per execution and disposes it on reconcile/disable/delete.
 */
export interface ArmedTrigger {
  dispose(): void;
  /**
   * Called instead of dispose when the execution was deleted, switched off or
   * its trigger changed, so a trigger can also end outside state that would
   * otherwise linger (an MCP event subscription). Pause and shutdown dispose.
   */
  retire?(): void;
  /** Next fire time as ISO string, when the trigger type can know it. */
  nextRun?(): string | null;
}
