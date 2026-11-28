// Tells flow-event triggers that a chat, API or manual run finished.
import { getFlowRunEventBus, type FlowRunFiredBy } from '@/backend/services/scheduler/flowRunEventBus';
import { assertFlowExecutionCurrent } from '@/backend/execution/flow/executionAuthority';
import type { SharedState } from '@/backend/execution/flow/types';
import { flowService } from '@/backend/services/flow/index';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/execution/flow/runFlowEvents');

/** Cap the output carried on a runFlow-originated FlowRunEvent (issue #116). */
const MAX_EVENT_OUTPUT_CHARS = 4096;

/**
 * Announce a terminal run on the process-global FlowRunEvent bus (issue #116)
 * so `flow-event` triggers can react to chat/API/manual runs. ONLY called for
 * non-scheduled root runs (`runDepth === 0`): scheduler-fired runs are
 * announced by SchedulerService.fire() with the precise stored output + chain
 * depth, and subflow stages must never emit. Best-effort and never throws.
 */
export async function publishRunFlowEvent(
  state: SharedState,
  status: 'completed' | 'error',
  outputText: string | undefined
): Promise<void> {
  try {
    const flowId = state.flowId;
    if (!flowId) {
      return;
    }
    let flowName: string | undefined = state.flowSnapshot?.name;
    if (!state.flowSnapshot) {
      try {
        flowName = (await flowService.getFlow(flowId))?.name ?? undefined;
      } catch {
        /* best-effort name resolution */
      }
    }
    // Scheduled/triggered runs are filtered out before this is ever called.
    const firedBy: FlowRunFiredBy = state.source === 'chat' ? 'chat' : 'api';
    const trimmed =
      outputText && outputText.length > MAX_EVENT_OUTPUT_CHARS
        ? `${outputText.slice(0, MAX_EVENT_OUTPUT_CHARS)}…`
        : outputText;
    // Flow-name resolution can cross an arbitrary I/O boundary. Check the
    // Activity lease / meeting generation only after it completes and directly
    // before the process-visible publication. Authority loss is caught by this
    // best-effort helper, suppressing the stale event without rejecting runFlow.
    await assertFlowExecutionCurrent(state);
    getFlowRunEventBus().publish({
      flowId,
      flowName,
      executionId: state.plannedExecutionId,
      runId: state.conversationId || '',
      conversationId: state.conversationId || '',
      status,
      outputText: trimmed,
      firedBy,
      chainDepth: state.chainDepth ?? 0,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.warn('Failed to publish runFlow flow-run event:', error);
  }
}
