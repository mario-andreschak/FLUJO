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
  var __flujo_workspace_layout_status: WorkspaceLayoutStatus | undefined;
}

export type WorkspaceLayoutStatus = 'not-started' | 'preparing' | 'ready' | 'failed';

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

export function getWorkspaceLayoutStatus(): WorkspaceLayoutStatus {
  return global.__flujo_workspace_layout_status ?? 'not-started';
}

export function setWorkspaceLayoutPreparation<T>(promise: Promise<T> | undefined): void {
  global.__flujo_workspace_migration_promise = promise;
  global.__flujo_workspace_layout_status = promise ? 'preparing' : 'not-started';
  if (!promise) return;

  // Observe completion without replacing the shared promise. Routes can inspect
  // this state without awaiting a potentially long first-run migration, while
  // data-bearing routes continue to await the original barrier.
  void promise.then(
    () => {
      if (global.__flujo_workspace_migration_promise === promise) {
        global.__flujo_workspace_layout_status = 'ready';
      }
    },
    () => {
      if (global.__flujo_workspace_migration_promise === promise) {
        global.__flujo_workspace_layout_status = 'failed';
      }
    },
  );
}

/** Record a failed attempt while allowing a later process/startup to retry it. */
export function failWorkspaceLayoutPreparation<T>(promise: Promise<T>, _error: unknown): void {
  if (global.__flujo_workspace_migration_promise !== promise) return;
  global.__flujo_workspace_migration_promise = undefined;
  global.__flujo_workspace_layout_status = 'failed';
}

/** Await the startup-owned migration without importing its implementation. */
export async function waitForWorkspaceLayoutReady(): Promise<void> {
  const promise = getWorkspaceLayoutPreparation();
  if (!promise) throw new WorkspaceLayoutNotStartedError();
  await promise;
}
