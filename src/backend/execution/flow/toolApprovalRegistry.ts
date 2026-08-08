import type OpenAI from 'openai';
import { workspaceCacheKey } from '@/utils/workspace';

/**
 * In-memory registry of tool calls awaiting human approval for self-orchestrating
 * adapters (Claude subscription). Unlike FLUJO's normal approval flow — which
 * pauses the run, returns to the client, and resumes in a later request — an
 * agentic SDK owns the loop inside a single live request. So `canUseTool` must
 * block until the user decides: it registers a pending approval here and awaits
 * the resolve callback, which the `/respond` route invokes.
 *
 * Module-level singleton, mirroring FlowExecutor.conversationStates and the
 * ExecutionEventBus (survives Next.js dev hot-reloads via globalThis).
 */
interface PendingApproval {
  toolCall: OpenAI.ChatCompletionMessageFunctionToolCall;
  resolve: (approved: boolean, feedback?: string) => void;
}

const globalForRegistry = globalThis as unknown as {
  __flujoToolApprovals?: Map<string, Map<string, PendingApproval>>;
};
const registry: Map<string, Map<string, PendingApproval>> =
  globalForRegistry.__flujoToolApprovals ?? (globalForRegistry.__flujoToolApprovals = new Map());

/** Register a tool call awaiting approval, keyed by conversation + tool-call id. */
export function registerPendingApproval(
  conversationId: string,
  toolCall: OpenAI.ChatCompletionMessageFunctionToolCall,
  resolve: (approved: boolean, feedback?: string) => void
): void {
  const key = workspaceCacheKey(conversationId);
  let perConv = registry.get(key);
  if (!perConv) {
    perConv = new Map();
    registry.set(key, perConv);
  }
  perConv.set(toolCall.id, { toolCall, resolve });
}

/**
 * Resolve a pending approval (approve/reject). Returns true if a matching pending
 * call existed — the `/respond` route uses this to distinguish an in-request
 * agentic approval (just unblock) from the normal pause/resume flow.
 */
export function resolvePendingApproval(
  conversationId: string,
  toolCallId: string,
  approved: boolean,
  feedback?: string   // Issue #247: optional rejection feedback for the model
): boolean {
  const key = workspaceCacheKey(conversationId);
  const perConv = registry.get(key);
  const pending = perConv?.get(toolCallId);
  if (!perConv || !pending) return false;
  perConv.delete(toolCallId);
  if (perConv.size === 0) registry.delete(key);
  pending.resolve(approved, feedback);
  return true;
}

/** The tool calls currently awaiting approval for a conversation. */
export function listPendingToolCalls(
  conversationId: string
): OpenAI.ChatCompletionMessageFunctionToolCall[] {
  const perConv = registry.get(workspaceCacheKey(conversationId));
  if (!perConv) return [];
  return Array.from(perConv.values(), p => p.toolCall);
}

/** Reject and clear all pending approvals for a conversation (e.g. on cancel). */
export function clearPendingApprovals(conversationId: string): void {
  const key = workspaceCacheKey(conversationId);
  const perConv = registry.get(key);
  if (!perConv) return;
  for (const pending of perConv.values()) pending.resolve(false);
  registry.delete(key);
}
