import { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('backend/services/mcp/elicitationRegistry');

/**
 * In-memory registry of elicitation requests awaiting user responses.
 *
 * When an MCP server sends `elicitation/create` during a tool call, the handler
 * suspends execution by registering a promise here, fires an SSE event to the
 * frontend, and waits. The `/respond` route resolves (or cancels) the promise
 * when the user submits or dismisses the form.
 *
 * Module-level singleton, mirroring toolApprovalRegistry.ts and the
 * ExecutionEventBus (survives Next.js dev hot-reloads via globalThis).
 */
const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingElicitation {
  workspace: string;
  resolve: (result: ElicitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const globalForRegistry = globalThis as unknown as {
  __flujoElicitationRegistry?: Map<string, PendingElicitation>;
};
const registry: Map<string, PendingElicitation> =
  globalForRegistry.__flujoElicitationRegistry ??
  (globalForRegistry.__flujoElicitationRegistry = new Map());

/**
 * Register a pending elicitation and return a promise that resolves when the
 * user submits or cancels the form. Auto-cancels after `timeoutMs` ms
 * (default 5 minutes) to prevent promise leaks.
 */
export function registerPendingElicitation(
  elicitationId: string,
  timeoutMs: number = ELICITATION_TIMEOUT_MS
): Promise<ElicitResult> {
  const workspace = getCurrentWorkspace();
  const key = workspaceCacheKey(elicitationId);
  return new Promise<ElicitResult>((resolve) => {
    const timer = setTimeout(() => {
      if (registry.has(key)) {
        log.warn(`Elicitation ${elicitationId} timed out after ${timeoutMs}ms; auto-cancelling`);
        registry.delete(key);
        resolve({ action: 'cancel' });
      }
    }, timeoutMs);

    registry.set(key, { workspace, resolve, timer });
  });
}

/**
 * Resolve a pending elicitation (user submitted or cancelled). Returns true if
 * a matching pending elicitation existed — the `/respond` route uses this to
 * distinguish an elicitation response from other action types.
 */
export function resolveElicitation(
  elicitationId: string,
  result: ElicitResult
): boolean {
  const key = workspaceCacheKey(elicitationId);
  const pending = registry.get(key);
  if (!pending) return false;
  clearTimeout(pending.timer);
  registry.delete(key);
  pending.resolve(result);
  return true;
}

/** Cancel a pending elicitation (server-side or timeout path). */
export function cancelElicitation(elicitationId: string): boolean {
  return resolveElicitation(elicitationId, { action: 'cancel' });
}

/** Cancel all pending elicitations for clean shutdown (e.g. server disconnect). */
export function clearAllElicitations(): void {
  const workspace = getCurrentWorkspace();
  for (const [id, pending] of registry.entries()) {
    if (pending.workspace !== workspace) continue;
    clearTimeout(pending.timer);
    pending.resolve({ action: 'cancel' });
    registry.delete(id);
  }
}
