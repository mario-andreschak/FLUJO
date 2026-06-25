import { FlujoChatMessage } from '@/shared/types/chat';

// The synthetic user message the run loop used to append after a handoff to
// un-stall the receiving model. Stripped here (and no longer produced) so it
// never reaches a model or the displayed conversation.
const HANDOFF_CONTINUE_MESSAGE = 'The handoff was successful. Continue';

function isHandoffToolName(name: string): boolean {
  return name === 'handoff' || name.startsWith('handoff_to_');
}

/**
 * Policy deciding what conversation a node's model actually sees.
 *
 * - `full` — the legacy behavior: the node sees every non-system message in
 *   order with its own system prompt on top.
 * - `scoped` — `full`, minus FLUJO **handoff plumbing**: the assistant turn that
 *   carried a `handoff_to_*` tool call, that call's tool result, and the
 *   synthetic "Continue" message. This removes the dangling handoff tool-call
 *   and the fake user turn from the receiving model's view, so it responds to
 *   the real task naturally. Real (MCP) tool-call/result pairs and the node's
 *   own agent-loop history are left intact, so this is safe for agent loops.
 *
 * (A fuller per-node scoping — not showing one agent all of another agent's
 * tool mechanics — rides on the Phase 3 event-log model where node attribution
 * is reliable by construction. See ~/.claude/plans/execution-core-v2.md.)
 */
export type NodeContextPolicy = 'full' | 'scoped';

export function buildNodeContext(
  messages: FlujoChatMessage[],
  systemMessage: FlujoChatMessage,
  policy: NodeContextPolicy = 'full',
): FlujoChatMessage[] {
  const nonSystem = messages.filter((m) => m.role !== 'system');

  if (policy === 'full') {
    return [systemMessage, ...nonSystem];
  }

  // 'scoped': collect the ids of handoff tool calls so we can also drop their
  // matching tool results, then strip the handoff turns + the "Continue" nudge.
  const handoffToolCallIds = new Set<string>();
  for (const m of nonSystem) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.type === 'function' && isHandoffToolName(tc.function.name)) {
          handoffToolCallIds.add(tc.id);
        }
      }
    }
  }

  const kept: FlujoChatMessage[] = [];
  for (const m of nonSystem) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim() === HANDOFF_CONTINUE_MESSAGE) {
      continue;
    }
    if (
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.type === 'function' && isHandoffToolName(tc.function.name))
    ) {
      continue;
    }
    if (m.role === 'tool' && m.tool_call_id && handoffToolCallIds.has(m.tool_call_id)) {
      continue;
    }
    kept.push(m);
  }

  return [systemMessage, ...kept];
}
