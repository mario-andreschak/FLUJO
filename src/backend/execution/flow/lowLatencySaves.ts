import type { SharedState } from './types';

/**
 * Fewer saves per flow turn (#1408).
 *
 * A flow turn saves the whole conversation at every step boundary: before and
 * after each step, when the run starts and when it ends. Most of these saves
 * are written again a few milliseconds later by the next one. The step
 * boundaries that carry no tool effect and the successful end of a run update
 * the conversation in memory and in the event log only; the next full save of
 * the run writes them (see `RecoveryDurability` in recoveryCheckpoint.ts).
 *
 * Never deferred: the checkpoints before and after a tool that may change
 * something, the start of a run, pauses, failures and the final save. So a
 * crash still cannot repeat a tool's side effect. What changes after a crash
 * mid-turn is only which step the interrupted turn names as its last one.
 *
 * Debugger, Persona and execution-extension runs always save at every step.
 */

/** Whether this run may leave a step boundary's save to its next full save. */
export function mayDeferConversationSave(state: SharedState): boolean {
  return !(state.ephemeral || state.debugMode || state.personaAttribution
    || state.executionExtensionContext || state.executionExtensionOwned);
}
