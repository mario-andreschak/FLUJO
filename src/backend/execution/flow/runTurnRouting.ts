// Chooses where a turn enters the flow: the named step, past a Finish step, or the errored turn's entry.
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState } from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { flowService } from '@/backend/services/flow/index';
import { nodeAfterFinishStep } from '@/backend/execution/flow/finishReentry';
import type { RunStateSource } from './runStateLoading';

const log = createLogger('backend/execution/flow/runTurnRouting');

/** What start-of-turn routing needs from runFlow. */
export type TurnStartRouting = {
  sharedState: SharedState;
  effectiveConvId: string;
  userTurn: boolean;
  stateSource: RunStateSource;
  ephemeral: boolean;
  /** The step an edit names explicitly; routing leaves such a turn alone. */
  processNodeId?: string;
  resumingAfterError: boolean;
  messagesBeforeTurn: FlujoChatMessage[];
};

/**
 * Chooses the node a turn starts at: a new user message goes to the step it
 * names (or past a finished Finish step), a Retry after an error replays the
 * turn from its entry node, and every user turn compiles the flow afresh.
 */
export async function routeTurnStart(routing: TurnStartRouting): Promise<void> {
  const { sharedState, effectiveConvId, userTurn, stateSource, ephemeral, processNodeId, resumingAfterError, messagesBeforeTurn } = routing;
  // --- Direct a new user turn to its intended node (one-time, at turn start) ---
  if (userTurn && stateSource !== 'new' && !processNodeId) {
    const lastMsg = sharedState.messages.length > 0
      ? sharedState.messages[sharedState.messages.length - 1]
      : undefined;
    if (lastMsg?.role === 'user' && lastMsg.processNodeId && lastMsg.processNodeId !== sharedState.currentNodeId) {
      log.info(`New user turn for ${effectiveConvId}: directing execution to node ${lastMsg.processNodeId} (was ${sharedState.currentNodeId}).`);
      sharedState.currentNodeId = lastMsg.processNodeId;
      FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
    }
    // A message without a step would otherwise run the Finish step again: no
    // model is called and the run still says "completed".
    if (sharedState.flowId && sharedState.currentNodeId) {
      try {
        // A caller that sends the whole history sends it without step ids, so
        // the saved history from before this turn still names the last step.
        const reentryNodeId = nodeAfterFinishStep(
          sharedState.flowSnapshot ?? await flowService.getFlow(sharedState.flowId),
          sharedState.currentNodeId,
          [...messagesBeforeTurn, ...sharedState.messages],
        );
        if (reentryNodeId) {
          log.info(`New user turn for ${effectiveConvId} after a Finish step: continuing at node ${reentryNodeId} (was ${sharedState.currentNodeId}).`);
          sharedState.currentNodeId = reentryNodeId;
          FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
        }
      } catch (error) {
        // The entry check below reads the same flow and ends this turn with a
        // clear message when the flow store cannot be read.
        log.warn(`Could not read the flow to leave the Finish step for ${effectiveConvId}`, error);
      }
    }
  }

  // --- Replay an errored turn from its entry node (issue #151) ---
  // The Retry button re-sends the existing history with NO new user message, so
  // the redirect above (which only fires for a fresh trailing user turn) leaves
  // execution parked at the errored mid-flow node. Resuming directly there when
  // that node uses `latest-message`/`isolated` narrows the wire to just the
  // current turn's tail and drops all prior conversation — the reported context
  // loss. Instead, when resuming an ERRORED conversation with no fresh user turn
  // and no explicit edit target, re-enter at the turn's ENTRY node (the
  // processNodeId of the last user message) so a full-history entry node rebuilds
  // context before routing forward. Falls back to the flow's start node when that
  // message is unstamped. Persisted conversations only (never ephemeral runs).
  if (resumingAfterError && userTurn && !ephemeral && stateSource !== 'new' && !processNodeId) {
    const lastMsg = sharedState.messages.length > 0
      ? sharedState.messages[sharedState.messages.length - 1]
      : undefined;
    // A fresh trailing user turn is already handled by the redirect above; only
    // act on a Retry (history ends on an assistant/tool message).
    if (lastMsg?.role !== 'user') {
      let entryNodeId: string | undefined;
      for (let i = sharedState.messages.length - 1; i >= 0; i--) {
        if (sharedState.messages[i].role === 'user') {
          entryNodeId = sharedState.messages[i].processNodeId;
          break;
        }
      }
      if (!entryNodeId && sharedState.flowId) {
        try {
          const flow = sharedState.flowSnapshot
            ?? await flowService.getFlow(sharedState.flowId);
          entryNodeId = flow?.nodes?.find((n) => n.type === 'start')?.id;
        } catch (err) {
          log.warn(`Could not resolve start node for error-resume of ${effectiveConvId}`, err);
        }
      }
      if (entryNodeId && entryNodeId !== sharedState.currentNodeId) {
        log.info(`Error-resume for ${effectiveConvId}: replaying turn from entry node ${entryNodeId} (was ${sharedState.currentNodeId}).`);
        sharedState.currentNodeId = entryNodeId;
        FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      }
    }
  }

  // --- Force a fresh compiled flow at the start of each user turn ---
  if (userTurn && sharedState.flowId) {
    FlowExecutor.clearFlowCache(sharedState.flowId);
    log.debug(`Cleared compiled-flow cache for ${sharedState.flowId} at start of user turn ${effectiveConvId}.`);
  }
}
