import { FlujoChatMessage } from '@/shared/types/chat';

// The synthetic user message the run loop used to append after a handoff to
// un-stall the receiving model. No longer produced; also stripped from the wire
// defensively (old conversations may still contain it).
const HANDOFF_CONTINUE_MESSAGE = 'The handoff was successful. Continue';

function isHandoffToolName(name: string): boolean {
  return name === 'handoff' || name.startsWith('handoff_to_');
}

/**
 * Assemble a node's conversation history: drop any pre-existing system messages,
 * put the node's own system prompt first, keep every other message in order.
 *
 * This is the chokepoint for what becomes the node's threaded history (it is
 * written back to SharedState.messages by ProcessNode). It MUST be lossless
 * w.r.t. non-system messages — scoping what the *model* sees is a separate
 * concern handled at the provider boundary by stripHandoffPlumbing (see below),
 * so persisted history is never destroyed. See ~/.claude/plans/execution-core-v2.md.
 */
export function buildNodeContext(
  messages: FlujoChatMessage[],
  systemMessage: FlujoChatMessage,
): FlujoChatMessage[] {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  return [systemMessage, ...nonSystem];
}

/**
 * Filter applied to the messages sent **to the model** (the wire view), NOT to
 * the threaded history. Removes FLUJO handoff plumbing so a node that was handed
 * off to sees a clean conversation ending on the real task instead of a dangling
 * `handoff_to_*` tool-call and a synthetic "Continue":
 *   - the assistant turn that carried a handoff tool call,
 *   - that call's tool result (matched by tool_call_id),
 *   - the synthetic "Continue" user message.
 *
 * Real (MCP) tool-call/result pairs and a node's own agent-loop history are
 * preserved, so agent loops are unaffected. System messages pass through.
 */
export function stripHandoffPlumbing(messages: FlujoChatMessage[]): FlujoChatMessage[] {
  const handoffToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.type === 'function' && isHandoffToolName(tc.function.name)) {
          handoffToolCallIds.add(tc.id);
        }
      }
    }
  }

  return messages.filter((m) => {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim() === HANDOFF_CONTINUE_MESSAGE) {
      return false;
    }
    if (
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.type === 'function' && isHandoffToolName(tc.function.name))
    ) {
      return false;
    }
    if (m.role === 'tool' && m.tool_call_id && handoffToolCallIds.has(m.tool_call_id)) {
      return false;
    }
    return true;
  });
}
