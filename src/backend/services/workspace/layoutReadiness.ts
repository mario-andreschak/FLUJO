/**
 * Lightweight process-wide workspace-layout readiness gate.
 *
 * This module deliberately has no dependency on the migration implementation.
 * Every workspace-aware route imports the gate, so importing migration.ts here
 * would make Webpack pull the full transactional filesystem engine into every
 * route entry and exhaust the production-build heap.
 */

declare global {
  // Global-backed because Next.js evaluates modules in several server graphs.
  // The migration module owns creation/retry; request handlers only await it.
  var __flujo_workspace_migration_promise: Promise<unknown> | undefined;
}

export class WorkspaceLayoutNotStartedError extends Error {
  readonly code = 'WORKSPACE_LAYOUT_NOT_STARTED';

  constructor() {
    super('Workspace layout preparation has not started.');
    this.name = 'WorkspaceLayoutNotStartedError';
  }
}

export function getWorkspaceLayoutPreparation<T = unknown>(): Promise<T> | undefined {
  return global.__flujo_workspace_migration_promise as Promise<T> | undefined;
}

export function setWorkspaceLayoutPreparation<T>(promise: Promise<T> | undefined): void {
  global.__flujo_workspace_migration_promise = promise;
}

/** Await the startup-owned migration without importing its implementation. */
export async function waitForWorkspaceLayoutReady(): Promise<void> {
  const promise = getWorkspaceLayoutPreparation();
  if (!promise) throw new WorkspaceLayoutNotStartedError();
  await promise;
}

