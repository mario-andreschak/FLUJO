/**
 * Per-run elicitation context, keyed by MCP server name.
 *
 * The elicitation handler is registered once at client-creation time, but it
 * needs run-time context (conversationId, unattended flag) to emit SSE events
 * and decide whether to auto-cancel. `runFlow.ts` writes this context when a
 * run's MCP servers are resolved and clears it in its finalize block.
 *
 * Using server name as the key is sound because FLUJO's execution model
 * runs one active conversation per server at a time; the context is always
 * set to the most recently started run and cleared on completion.
 *
 * Survives Next.js dev hot-reloads via globalThis (same pattern as the
 * ExecutionEventBus and toolApprovalRegistry).
 */
import { workspaceCacheKey } from '@/utils/workspace';

export interface ElicitationRunContext {
  conversationId: string;
  /** Returns true when the run is unattended (scheduled/headless). */
  getUnattended: () => boolean;
}

const globalForCtx = globalThis as unknown as {
  __flujoElicitationContexts?: Map<string, ElicitationRunContext>;
};
const contexts: Map<string, ElicitationRunContext> =
  globalForCtx.__flujoElicitationContexts ??
  (globalForCtx.__flujoElicitationContexts = new Map());

/** Bind a run context to a server name. Called at run start by runFlow.ts. */
export function setElicitationContext(
  serverName: string,
  ctx: ElicitationRunContext
): void {
  contexts.set(workspaceCacheKey(serverName), ctx);
}

/** Remove the run context for a server. Called in the runFlow.ts finalize block. */
export function clearElicitationContext(serverName: string): void {
  contexts.delete(workspaceCacheKey(serverName));
}

/** Retrieve the active run context for a server (undefined if not in a run). */
export function getElicitationContext(
  serverName: string
): ElicitationRunContext | undefined {
  return contexts.get(workspaceCacheKey(serverName));
}
