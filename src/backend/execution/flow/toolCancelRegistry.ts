/**
 * Registry of AbortControllers for tool calls that are currently IN FLIGHT
 * (issue #357). It lets the user cancel a single stalling tool call from the
 * chat UI without killing the whole run.
 *
 * Keyed by scope (the conversation id when the run is conversation-bound, the
 * logical run id for ephemeral/subflow runs) + toolCallId, so ids from
 * different runs can never collide.
 *
 * Module-level singleton on globalThis, mirroring toolApprovalRegistry (survives
 * Next.js dev hot-reloads and the route/worker module split).
 */
import { workspaceCacheKey } from '@/utils/workspace';

const globalForRegistry = globalThis as unknown as {
  __flujoToolCancels?: Map<string, Map<string, AbortController>>;
};
const registry: Map<string, Map<string, AbortController>> =
  globalForRegistry.__flujoToolCancels ?? (globalForRegistry.__flujoToolCancels = new Map());

/**
 * Register a fresh AbortController for an about-to-be-dispatched tool call and
 * return it. Always paired with `releaseToolCall` in a `finally` so controllers
 * never leak.
 */
export function registerToolCall(scope: string, toolCallId: string): AbortController {
  const controller = new AbortController();
  const key = workspaceCacheKey(scope);
  let perScope = registry.get(key);
  if (!perScope) {
    perScope = new Map();
    registry.set(key, perScope);
  }
  perScope.set(toolCallId, controller);
  return controller;
}

/** Drop a finished call's controller. */
export function releaseToolCall(scope: string, toolCallId: string): void {
  const key = workspaceCacheKey(scope);
  const perScope = registry.get(key);
  if (!perScope) return;
  perScope.delete(toolCallId);
  if (perScope.size === 0) registry.delete(key);
}

/**
 * Abort one in-flight tool call. Returns false when there is no such call
 * (already finished, or never started) — callers treat that as a race-safe
 * no-op rather than an error.
 */
export function cancelToolCall(scope: string, toolCallId: string): boolean {
  const controller = registry.get(workspaceCacheKey(scope))?.get(toolCallId);
  if (!controller) return false;
  releaseToolCall(scope, toolCallId);
  controller.abort(new Error('Tool call cancelled by user.'));
  return true;
}

/**
 * Abort every in-flight tool call of a scope. Used by the whole-run Stop so
 * pressing Stop also interrupts a call that is already dispatched, instead of
 * only preventing the next one.
 */
export function cancelAllToolCalls(scope: string): number {
  const key = workspaceCacheKey(scope);
  const perScope = registry.get(key);
  if (!perScope) return 0;
  const controllers = Array.from(perScope.values());
  registry.delete(key);
  for (const controller of controllers) controller.abort(new Error('Run cancelled by user.'));
  return controllers.length;
}

/** The tool-call ids currently in flight for a scope (diagnostics/tests). */
export function listInFlightToolCalls(scope: string): string[] {
  return Array.from(registry.get(workspaceCacheKey(scope))?.keys() ?? []);
}
