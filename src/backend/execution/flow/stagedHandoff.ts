// Finds the assistant message that staged a handoff and the calls it left unanswered.
import type OpenAI from 'openai';
import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { requireFunctionToolCalls } from '@/shared/types/openai';

export const isHandoffToolCall = (call: OpenAI.ChatCompletionMessageFunctionToolCall): boolean =>
  call.function.name === 'handoff' || call.function.name.startsWith('handoff_to_');

/** Find the assistant batch which owns a staged handoff. Tool/approval results
 * may already follow it, so callers must not assume it is the last message. */
export function findStagedHandoffAssistant(state: SharedState): FlujoChatMessage | undefined {
  return [...state.messages].reverse().find((message) =>
    message.role === 'assistant'
    && requireFunctionToolCalls(message.tool_calls).some(isHandoffToolCall),
  );
}

export function unansweredOrdinaryCalls(
  state: SharedState,
  assistant: FlujoChatMessage,
): OpenAI.ChatCompletionMessageFunctionToolCall[] {
  const answeredIds = new Set(
    state.messages
      .filter((message) => message.role === 'tool' && !!(message as { tool_call_id?: string }).tool_call_id)
      .map((message) => (message as { tool_call_id: string }).tool_call_id),
  );
  return requireFunctionToolCalls(assistant.tool_calls).filter(
    (call) => !isHandoffToolCall(call) && !answeredIds.has(call.id),
  );
}
