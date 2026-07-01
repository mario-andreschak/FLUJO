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

// Does this message carry any renderable text? (assistant content is a string
// in FLUJO; array-of-parts is handled defensively for OpenAI-shaped imports)
function hasTextContent(m: FlujoChatMessage): boolean {
  if (typeof m.content === 'string') return m.content.trim().length > 0;
  if (Array.isArray(m.content)) return (m.content as unknown[]).length > 0;
  return false;
}

/**
 * Filter applied to the messages sent **to the model** (the wire view), NOT to
 * the threaded history. Removes FLUJO handoff *mechanics* so a node that was
 * handed off to sees a clean conversation ending on the real task instead of a
 * dangling `handoff_to_*` tool-call and a synthetic "Continue":
 *   - handoff tool calls are removed from their assistant turn — but the turn's
 *     TEXT is kept: the departing agent's own summary/answer is the receiving
 *     model's "previous turn is done" boundary, and dropping it makes models
 *     re-count earlier work (see plan §10.1a). The turn is dropped entirely
 *     only when it is pure routing (no text, no other tool calls),
 *   - each handoff call's tool result (matched by tool_call_id),
 *   - the synthetic "Continue" user message.
 *
 * Real (MCP) tool-call/result pairs and a node's own agent-loop history are
 * preserved — including real calls made in the same turn as a handoff.
 * System messages pass through. Never mutates the input messages.
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

  const out: FlujoChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim() === HANDOFF_CONTINUE_MESSAGE) {
      continue;
    }
    if (m.role === 'tool' && m.tool_call_id && handoffToolCallIds.has(m.tool_call_id)) {
      continue;
    }
    if (
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.type === 'function' && isHandoffToolName(tc.function.name))
    ) {
      const realToolCalls = m.tool_calls.filter(
        (tc) => !(tc.type === 'function' && isHandoffToolName(tc.function.name)),
      );
      if (realToolCalls.length > 0) {
        out.push({ ...m, tool_calls: realToolCalls });
      } else if (hasTextContent(m)) {
        // Keep the agent's prose as a plain assistant turn (the turn boundary);
        // omit tool_calls entirely so no provider sees a dangling call.
        const { tool_calls: _dropped, ...rest } = m;
        out.push(rest as FlujoChatMessage);
      }
      // else: pure routing turn (no text, no real calls) — drop it.
      continue;
    }
    out.push(m);
  }
  return out;
}
