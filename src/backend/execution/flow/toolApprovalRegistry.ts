import type OpenAI from 'openai';
import { randomUUID } from 'crypto';
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
  conversationId: string;
  toolCall: OpenAI.ChatCompletionMessageFunctionToolCall;
  resolve: (approved: boolean) => void;
  /** Opaque id the approval inbox lists for this one call (#1284); it stops working once the call is answered. */
  receipt: string;
  createdAt: number;
  /** When the wait gives up without running the tool. */
  expiresAt?: number;
}

/** A live wait as the approval inbox lists it: ids, tool name and times, never arguments. */
export interface LiveApprovalListing {
  receipt: string;
  conversationId: string;
  toolCall: { id: string; name: string };
  createdAt: number;
  expiresAt?: number;
}

const globalForRegistry = globalThis as unknown as {
  __flujoToolApprovals?: Map<string, Map<string, PendingApproval>>;
};
const registry: Map<string, Map<string, PendingApproval>> =
  globalForRegistry.__flujoToolApprovals ?? (globalForRegistry.__flujoToolApprovals = new Map());

/** Register a tool call awaiting approval, keyed by conversation + tool-call id. Returns its inbox receipt. */
export function registerPendingApproval(
  conversationId: string,
  toolCall: OpenAI.ChatCompletionMessageFunctionToolCall,
  resolve: (approved: boolean) => void,
  expiresAt?: number,
): string {
  const key = workspaceCacheKey(conversationId);
  let perConv = registry.get(key);
  if (!perConv) {
    perConv = new Map();
    registry.set(key, perConv);
  }
  const receipt = `apr_${randomUUID()}`;
  perConv.set(toolCall.id, { conversationId, toolCall, resolve, receipt, createdAt: Date.now(), ...(expiresAt ? { expiresAt } : {}) });
  return receipt;
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
): boolean {
  const key = workspaceCacheKey(conversationId);
  const perConv = registry.get(key);
  const pending = perConv?.get(toolCallId);
  if (!perConv || !pending) return false;
  perConv.delete(toolCallId);
  if (perConv.size === 0) registry.delete(key);
  pending.resolve(approved);
  return true;
}

/**
 * Take a pending approval back without answering it, for a wait that ended
 * (it expired or the run stopped). Returns true when it was still pending.
 */
export function withdrawPendingApproval(conversationId: string, toolCallId: string): boolean {
  const key = workspaceCacheKey(conversationId);
  const perConv = registry.get(key);
  if (!perConv?.delete(toolCallId)) return false;
  if (perConv.size === 0) registry.delete(key);
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

/** Every live wait of the current workspace, oldest first, for the approval inbox. */
export function listLiveApprovals(): LiveApprovalListing[] {
  const listed: LiveApprovalListing[] = [];
  for (const [key, perConv] of registry) {
    for (const pending of perConv.values()) {
      if (workspaceCacheKey(pending.conversationId) !== key) continue;
      listed.push({
        receipt: pending.receipt,
        conversationId: pending.conversationId,
        toolCall: { id: pending.toolCall.id, name: pending.toolCall.function.name },
        createdAt: pending.createdAt,
        ...(pending.expiresAt ? { expiresAt: pending.expiresAt } : {}),
      });
    }
  }
  return listed.sort((a, b) => a.createdAt - b.createdAt);
}

/** The live wait an inbox receipt names in the current workspace, while it still waits. */
export function findLiveApproval(receipt: string): LiveApprovalListing | undefined {
  return listLiveApprovals().find((listed) => listed.receipt === receipt);
}

/** Reject and clear all pending approvals for a conversation (e.g. on cancel). */
export function clearPendingApprovals(conversationId: string): void {
  const key = workspaceCacheKey(conversationId);
  const perConv = registry.get(key);
  if (!perConv) return;
  for (const pending of perConv.values()) pending.resolve(false);
  registry.delete(key);
}
