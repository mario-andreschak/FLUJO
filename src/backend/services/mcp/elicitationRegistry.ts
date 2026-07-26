import { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';

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
  return new Promise<ElicitResult>((resolve) => {
    const timer = setTimeout(() => {
      if (registry.has(elicitationId)) {
        log.warn(`Elicitation ${elicitationId} timed out after ${timeoutMs}ms; auto-cancelling`);
        registry.delete(elicitationId);
        resolve({ action: 'cancel' });
      }
    }, timeoutMs);

    registry.set(elicitationId, { resolve, timer });
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
  const pending = registry.get(elicitationId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  registry.delete(elicitationId);
  pending.resolve(result);
  return true;
}

/** Cancel a pending elicitation (server-side or timeout path). */
export function cancelElicitation(elicitationId: string): boolean {
  return resolveElicitation(elicitationId, { action: 'cancel' });
}

/** Cancel all pending elicitations for clean shutdown (e.g. server disconnect). */
export function clearAllElicitations(): void {
  for (const [id, pending] of registry.entries()) {
    clearTimeout(pending.timer);
    pending.resolve({ action: 'cancel' });
  }
  registry.clear();
}
