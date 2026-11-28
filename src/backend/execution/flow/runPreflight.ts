// Pre-run checks: flow validation, allowed models, the Quick Chat switch and entry conditions.
import { effectiveAllowedToolNames } from '@/utils/shared/decisionRules';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { traceSpan } from './turnTrace';
import { SharedState } from '@/backend/execution/flow/types';
import { flowService } from '@/backend/services/flow/index';
import { validateFlowForRun, validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { entryConditionStartNodeId } from '@/utils/shared/edgeConditions';
import { isQuickChatFlowId } from '@/utils/shared/quickChat';
import { intersectAllowedModels } from '@/utils/shared/flowModelBoundary';
import { isQuickChatEnabled, QUICK_CHAT_DISABLED_CODE, QUICK_CHAT_DISABLED_MESSAGE } from '@/backend/services/workspace/modelAccess';
import type { FlowRunInput } from './runFlowContract';
import type { RunStateSource } from './runStateLoading';

const log = createLogger('backend/execution/flow/runPreflight');

/** What the pre-run checks need from runFlow. */
export type RunPreflight = {
  sharedState: SharedState;
  input: FlowRunInput;
  effectiveConvId: string;
  userTurn: boolean;
  stateSource: RunStateSource;
};

/**
 * Checks a run may start before any node runs: the pinned flow validates,
 * the allowed models can be read (and only narrow), the Quick Chat switch is
 * on, and a flow with an entry condition re-enters at its Start node. A
 * failed check sets the state's error response and returns true; the run
 * then ends through runFlow's ordinary error path.
 */
export async function runPreflightChecks(preflight: RunPreflight): Promise<boolean> {
  const { sharedState, input, effectiveConvId, userTurn, stateSource } = preflight;
  let preflightError = false;
  // --- Pre-run consistency check (blocking) ---
  // Only at the start of a run: a genuine new user turn or a brand-new
  // conversation (which covers subflow child runs — this lives in the keystone
  // so EVERY caller gets it, not just the OpenAI route). Internal resumes
  // (debug step/continue, tool-approval respond) continue an already-started
  // run and must not be re-blocked. If the flow has error-level issues
  // (deleted model, renamed/deleted MCP server, missing Start node, dangling
  // tool references, …), abort before any node runs. The standard terminal/
  // error path below formats the result (and emits run:done).
  if ((userTurn || stateSource === 'new') && sharedState.flowId) {
    try {
      // Validate the pinned execution definition, including saved-flow runs.
      // Legacy conversations without a snapshot retain the by-id path.
      const validation = await traceSpan('preflight.validate', async () => sharedState.flowSnapshot
        ? await validateFlowObjectForRun(sharedState.flowSnapshot)
        : await validateFlowForRun(sharedState.flowId));
      if (!validation.isRunnable) {
        const errs = validation.issues.filter(i => i.severity === 'error');
        const message =
          `This flow can't run yet — please fix the following before running:\n` +
          errs.map(e => `• ${e.message}`).join('\n');
        log.warn(`Pre-run validation blocked flow ${sharedState.flowId} for conv ${effectiveConvId}`, {
          errorCount: errs.length,
          codes: errs.map(e => e.code),
        });
        sharedState.lastResponse = {
          success: false,
          error: message,
          errorDetails: { message, type: 'invalid_request_error', code: 'flow_invalid', status: 400 },
        };
        preflightError = true;
      }
    } catch (validationError) {
      // A failure to RUN the check must not block the user — log and proceed.
      log.warn(`Pre-run validation could not complete for ${sharedState.flowId}; proceeding`, validationError);
    }
  }

  // --- Allowed models ---
  // Read on every entry, because a resumed run must keep the same limit. The list can
  // only narrow within a conversation, and a subflow may not widen its parent's.
  if (sharedState.flowId && !preflightError) {
    try {
      const flowAllowed = (sharedState.flowSnapshot ?? await flowService.getFlow(sharedState.flowId))?.allowedModels;
      const parentState = input.parentRunId ? FlowExecutor.conversationStates.get(input.parentRunId) : undefined;
      const parentAllowed = parentState?.allowedModels;
      // A subflow's model steps stay inside the tools its parent's decision allows.
      sharedState.inheritedAllowedToolNames = parentState ? effectiveAllowedToolNames(parentState) : undefined;
      sharedState.allowedModels = intersectAllowedModels(intersectAllowedModels(flowAllowed, parentAllowed), sharedState.allowedModels);
    } catch (allowedModelsError) {
      // Skipping this could send data to a model the flow rules out. Only this turn fails.
      log.warn(`Could not read allowed models for ${sharedState.flowId}; ending this turn`, allowedModelsError);
      const message = 'FLUJO could not read which models this flow may use. Please send the message again.';
      sharedState.lastResponse = {
        success: false,
        error: message,
        errorDetails: { message, type: 'api_error', code: 'flow_allowed_models_unreadable', status: 503 },
      };
      preflightError = true;
    }
  }

  // --- Quick Chat switch ---
  // A conversation created before the switch was turned off must stop too, and it
  // would otherwise keep reaching its model. This covers every path into a run.
  if ((userTurn || stateSource === 'new') && !preflightError && isQuickChatFlowId(sharedState.flowId)) {
    let allowed = false;
    try {
      allowed = await isQuickChatEnabled();
    } catch (settingsError) {
      log.warn(`Could not read the Quick Chat switch for ${effectiveConvId}; ending this turn`, settingsError);
    }
    if (!allowed) {
      sharedState.lastResponse = {
        success: false,
        error: QUICK_CHAT_DISABLED_MESSAGE,
        errorDetails: { message: QUICK_CHAT_DISABLED_MESSAGE, type: 'invalid_request_error', code: QUICK_CHAT_DISABLED_CODE, status: 403 },
      };
      preflightError = true;
    }
  }

  // --- Re-check entry conditions on every user turn ---
  // A follow-up normally resumes at the last Process step, and an edit or a client
  // can name a step directly. Either would skip a condition placed before the first
  // model step, so a flow with such a condition always re-enters at its Start node.
  if (userTurn && stateSource !== 'new' && sharedState.flowId && !preflightError) {
    try {
      const entryNodeId = entryConditionStartNodeId(sharedState.flowSnapshot ?? await flowService.getFlow(sharedState.flowId));
      if (entryNodeId && entryNodeId !== sharedState.currentNodeId) {
        log.info(`Entry condition: re-entering ${effectiveConvId} at Start node ${entryNodeId} (was ${sharedState.currentNodeId}).`);
        sharedState.currentNodeId = entryNodeId;
        FlowExecutor.conversationStates.set(effectiveConvId, sharedState);
      }
    } catch (entryCheckError) {
      // Unlike the check above, skipping this one could let a message past a
      // condition. Only this turn fails; the next message reads the flow again.
      log.warn(`Could not read entry conditions for ${sharedState.flowId}; ending this turn`, entryCheckError);
      const message = 'FLUJO could not read this flow to check its conditions. Please send the message again.';
      sharedState.lastResponse = {
        success: false,
        error: message,
        errorDetails: { message, type: 'api_error', code: 'flow_entry_check_failed', status: 503 },
      };
      preflightError = true;
    }
  }

  return preflightError;
}
