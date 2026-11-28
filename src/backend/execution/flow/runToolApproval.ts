// Which tool calls a step requires a person for, and the live decision a sub-flow asks for instead of pausing.
import { getHarnessExecution } from '@/backend/services/harness/executionScope';
import OpenAI from 'openai';
import { SharedState } from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { waitForLiveToolDecision } from './toolApprovalGate';
import { decodeToolName, isToolOfferedInStep } from '@/backend/execution/flow/handlers/toolNamespace';

/** The current step requires a person for this call, whatever the run's setting.
 *  A call the step did not offer is left out: dispatch refuses it, so asking a
 *  person first would only offer a choice with no effect. */
export const stepRequiresApproval = (sharedState: SharedState, call: OpenAI.ChatCompletionMessageFunctionToolCall): boolean =>
  !getHarnessExecution()
  && isToolOfferedInStep(call.function.name, sharedState.offeredToolNames, sharedState.toolNameMap)
  && decodeToolName(call.function.name, sharedState.toolNameMap)?.requiresApproval === true;

/**
 * A sub-flow cannot pause on its own, so it asks the person live, in the
 * conversation they are viewing (#1284), on the same approval card as any
 * other call. Returns the ids of rejected calls, which get the fixed
 * `tool denied` result; the other calls may run. Undefined when this run
 * pauses or fails instead (it is not a sub-flow, or policy `fail`).
 */
export const decideHeldCallsLive = async (sharedState: SharedState, runtimeAbortSignal: AbortSignal | undefined, emitNewMessages: () => void,
  heldCalls: OpenAI.ChatCompletionMessageFunctionToolCall[],
): Promise<Set<string> | undefined> => {
  const approvalConversationId = sharedState.approvalConversationId;
  if (!approvalConversationId || sharedState.onApprovalRequired === 'fail') return undefined;
  const decisions = await Promise.allSettled(heldCalls.map((call) =>
    waitForLiveToolDecision(approvalConversationId, call, { signal: runtimeAbortSignal })));
  const failed = decisions.find((decision): decision is PromiseRejectedResult => decision.status === 'rejected');
  if (failed) throw failed.reason;
  const rejected = new Set(heldCalls
    .filter((_call, index) => (decisions[index] as PromiseFulfilledResult<boolean>).value !== true)
    .map((call) => call.id));
  for (const call of heldCalls) {
    if (!rejected.has(call.id)) continue;
    sharedState.messages.push({
      id: crypto.randomUUID(),
      role: 'tool',
      tool_call_id: call.id,
      content: 'tool denied',
      timestamp: Date.now(),
      processNodeId: sharedState.currentNodeId,
    } as FlujoChatMessage);
  }
  emitNewMessages();
  return rejected;
};
