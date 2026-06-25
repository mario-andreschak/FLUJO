import { FlujoChatMessage } from '@/shared/types/chat';

/**
 * Policy deciding what conversation a node's model actually sees.
 *
 * - `full` — TODAY's behavior: the node sees the entire shared conversation
 *   (every non-system message, in order) with its own rendered system prompt on
 *   top. This is the source of the multi-agent friction (every node gets the
 *   whole transcript, including other agents' tool-call/handoff plumbing).
 *
 * Execution-core-v2 Phase 2 will add a `scoped` policy that strips FLUJO
 * plumbing (handoff tool-calls/results, the synthetic "Continue" message,
 * sibling nodes' MCP tool pairs) and ends the context on a user/task turn — so
 * the receiving model responds naturally and the "Continue" hack disappears.
 * See ~/.claude/plans/execution-core-v2.md.
 */
export type NodeContextPolicy = 'full';

/**
 * The single chokepoint that decides which messages a node's LLM receives.
 *
 * Phase 1 (this) is a behavior-preserving extraction of the logic that lived
 * inline in ProcessNode.prep: drop any pre-existing system messages, then put
 * the node's own system prompt first followed by every other message in order.
 * Centralizing it here is the seam the re-architecture evolves — future policies
 * change ONLY this function, not every node.
 */
export function buildNodeContext(
  messages: FlujoChatMessage[],
  systemMessage: FlujoChatMessage,
  policy: NodeContextPolicy = 'full',
): FlujoChatMessage[] {
  // 'full': the legacy behavior. (Other policies arrive in Phase 2.)
  void policy;
  const nonSystem = messages.filter((m) => m.role !== 'system');
  return [systemMessage, ...nonSystem];
}
