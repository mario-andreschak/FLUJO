// Folds steering messages into a running flow at the next transcript-safe boundary.
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { appendRawForState } from '@/backend/execution/flow/conversationLog';
import {
  steeringCount,
  takeSteeringMessages,
  requeueSteeringMessages,
  markSteeringDelivered,
} from '@/backend/execution/flow/steeringInbox';
import { SharedState } from '@/backend/execution/flow/types';
import { resumeSubflowOrchestrator } from './subflowCommunication';

const log = createLogger('backend/execution/flow/runSteeringDrain');

// --- Mid-run steering (user intervention while the run is in flight) --------
// A correction is only useful if it reaches the model that is going the wrong
// way, so messages posted to /inject are folded into THIS run at the next safe
// boundary rather than queued for a run of their own.
//
// "Safe" means the transcript is well-formed: an assistant `tool_calls` turn
// whose results have not been appended yet must never be split by a user
// message (every provider 400s on that shape — the same invariant issue #256
// repairs after a crash). When the tail is mid-exchange we simply leave the
// messages in the inbox and try again on the next iteration, which is at most
// one tool batch away. This is also what defers a drain past the debug
// pending-tool-calls step below.
export const hasUnansweredToolCalls = (sharedState: SharedState): boolean => {
  const answered = new Set<string>();
  for (const m of sharedState.messages) {
    if (m.role === 'tool') {
      const id = (m as { tool_call_id?: string }).tool_call_id;
      if (id) answered.add(id);
    }
  }
  return sharedState.messages.some(
    (m) =>
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.id && !answered.has(tc.id)),
  );
};

/**
 * Fold any waiting steering messages into the live transcript. Returns true
 * when at least one was folded in (the caller keeps executing so the model
 * sees it on its very next call). Every child has its own addressable inbox,
 * including ephemeral children. Agent messages use this same safe boundary.
*/
export const drainSteering = async (sharedState: SharedState, effectiveConvId: string, emitNewMessages: (inputMessageIds?: ReadonlySet<string>) => void): Promise<boolean> => {
  if (hasUnansweredToolCalls(sharedState)) {
    log.debug(`Steering message(s) waiting for ${effectiveConvId} but a tool exchange is in flight; deferring.`);
    return false;
  }
  // Persona deliveries remain pending in the durable mailbox until this
  // transcript-safe boundary consumes and acknowledges their stable ids.
  // Generic fence assertions intentionally have no delivery side effects.
  await sharedState.executionAuthority?.pollRelatedInputs?.();
  if (steeringCount(effectiveConvId) === 0) return false;
  await resumeSubflowOrchestrator(sharedState);
  const injected = takeSteeringMessages(effectiveConvId);
  if (injected.length === 0) return false;
  const existingIds = new Set(sharedState.messages
    .map((message) => message.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0));
  const newlyFolded = injected.filter((message) =>
    !message.id || !existingIds.has(message.id));
  let foldedDurably = newlyFolded.length === 0;
  try {
    // Stamp the current node so the message is attributed to the step it is
    // steering (live-view lane placement + subflow projection tagging).
    for (const m of newlyFolded) {
      if (!m.id) m.id = crypto.randomUUID();
      delete m.executionOrigin;
      if (!m.processNodeId && sharedState.currentNodeId) m.processNodeId = sharedState.currentNodeId;
    }
    if (newlyFolded.length > 0) {
      sharedState.messages.push(...newlyFolded);
      sharedState.lastUserMessageAt = newlyFolded[newlyFolded.length - 1].timestamp ?? Date.now();
      FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      emitNewMessages(new Set(newlyFolded.map(message => message.id)));
      // Per-step durability is the append-only log, exactly as for tool
      // results (the log refuses ephemeral runs, which have no transcript).
      if (!sharedState.ephemeral) {
        await appendRawForState(
          sharedState,
          newlyFolded.map(message => ({ type: 'message', message, messageOrigin: 'input' })),
        );
      }
      foldedDurably = true;
    }
    const stableIds = injected
      .map((message) => message.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    // Every id is now in the transcript (newly or from an earlier fold), so
    // a sender waiting for delivery (an MCP event) may acknowledge it.
    markSteeringDelivered(effectiveConvId, stableIds);
    if (stableIds.length > 0) {
      await sharedState.executionAuthority?.acknowledgeRelatedInputs?.(stableIds);
    }
    log.info(`Folded ${newlyFolded.length} steering message(s) into the live run for ${effectiveConvId}.`);
    // An SDK may have persisted the transcript before rejecting delivery.
    // Its requeued message must still trigger another model turn even though
    // the stable transcript ID is already present.
    return true;
  } catch (error) {
    // If transcript persistence failed, undo the in-memory fold before
    // retrying. If only the durable mailbox ACK failed, keep the already
    // persisted fold; the next poll is deduplicated by stable message id and
    // retries acknowledgement without appending a second copy.
    if (!foldedDurably && newlyFolded.length > 0) {
      sharedState.messages.splice(
        Math.max(0, sharedState.messages.length - newlyFolded.length),
        newlyFolded.length,
      );
      FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
    }
    requeueSteeringMessages(effectiveConvId, injected);
    log.warn(`Failed to fold steering message(s) for ${effectiveConvId}; re-queued`, error);
    return false;
  }
};
