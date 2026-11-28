import type { SharedState } from './types';
import { getConversationStates } from './conversationStateRegistry';
import { isConversationExecutionLocked } from './conversationExecutionLock';
import { workspaceCacheKey } from '@/utils/workspace';

/**
 * A conversation's Require tool approvals setting while a run is going (#1284, R8).
 *
 * A run reads the setting each time it accepts a batch of tool calls, and an
 * agent SDK each time it is about to run a tool, so a change the person saves
 * mid-run applies from the next batch. Calls already on the approval card keep
 * waiting for their decision either way. While a change is being saved, the
 * next batch asks: asking once too often is safe, running a tool unasked is not.
 */

const globalForSaves = globalThis as typeof globalThis & { __flujoApprovalSettingSaves?: Map<string, number> };
const savesInFlight: Map<string, number> = globalForSaves.__flujoApprovalSettingSaves
  ?? (globalForSaves.__flujoApprovalSettingSaves = new Map());

/** The value the next batch of this conversation uses. `fallback` when no run of it is in memory. */
export function approvalSettingNow(conversationId: string | undefined, fallback: boolean): boolean {
  if (!conversationId) return fallback;
  if (savesInFlight.has(workspaceCacheKey(conversationId))) return true;
  const live = getConversationStates().get(conversationId);
  return live ? live.requireApproval === true : fallback;
}

/**
 * The value for the batch a run accepts now: the latest save of the
 * conversation on screen, which for a sub-flow is the one it asks in.
 */
export function approvalForBatch(sharedState: Pick<SharedState, 'approvalConversationId' | 'conversationId' | 'requireApproval'>): boolean {
  return approvalSettingNow(sharedState.approvalConversationId ?? sharedState.conversationId, sharedState.requireApproval === true);
}

/**
 * The setting a run starts with. A request that says nothing keeps the
 * conversation's saved value (missing is off); a request that says on or off
 * saves that value for this run and the ones after it.
 */
export function approvalSettingForRun(requested: boolean | undefined, saved: boolean | null | undefined): boolean {
  return requested === undefined ? saved === true : requested;
}

/**
 * Save a new value while a run of the conversation is going, without waiting
 * for that run to end: the change goes into the run's own state and is saved
 * with it, so the run's later saves keep it. Returns the saved state, or
 * undefined when no run is going (the caller saves the usual way then).
 * A failed save puts the old value back and throws.
 */
export async function saveApprovalSettingDuringRun(
  conversationId: string,
  value: boolean,
  persist: (state: SharedState) => Promise<void>,
): Promise<SharedState | undefined> {
  if (!isConversationExecutionLocked(conversationId)) return undefined;
  const live = getConversationStates().get(conversationId);
  if (!live || live.status !== 'running' || live.ephemeral || live.personaAttribution
    || live.personaInstructionContext || live.personaTargetId || live.personaArchived) return undefined;
  const key = workspaceCacheKey(conversationId);
  const previous = live.requireApproval;
  savesInFlight.set(key, (savesInFlight.get(key) ?? 0) + 1);
  live.requireApproval = value;
  try {
    await persist(live);
    return live;
  } catch (error) {
    if (live.requireApproval === value) live.requireApproval = previous;
    throw error;
  } finally {
    const left = (savesInFlight.get(key) ?? 1) - 1;
    if (left > 0) savesInFlight.set(key, left);
    else savesInFlight.delete(key);
  }
}
