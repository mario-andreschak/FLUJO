/**
 * Lightweight process-wide workspace-layout readiness gate.
 *
 * This module deliberately has no dependency on the migration implementation.
 * Every workspace-aware route imports the gate, so importing migration.ts here
 * would make Webpack pull the full transactional filesystem engine into every
 * route entry and exhaust the production-build heap.
 */
import { startupChanged, waitForStartup, type StartupWait } from './startupWait';

declare global {
  // Global-backed because Next.js evaluates modules in several server graphs.
  // The migration module owns creation/retry; request handlers only await it.
  var __flujo_workspace_migration_promise: Promise<unknown> | undefined;
  var __flujo_workspace_layout_status: WorkspaceLayoutStatus | undefined;
  var __flujo_workspace_layout_error: unknown;
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
  global.__flujo_workspace_layout_error = undefined;
  if (!promise) return;
  startupChanged();

  // Observe completion without replacing the shared promise. Routes can inspect
  // this state without awaiting a potentially long first-run migration, while
  // data-bearing routes continue to await the original barrier.
  void promise.then(
    () => {
      if (global.__flujo_workspace_migration_promise === promise) {
        global.__flujo_workspace_layout_status = 'ready';
      }
    },
    error => {
      if (global.__flujo_workspace_migration_promise === promise) {
        global.__flujo_workspace_layout_status = 'failed';
        global.__flujo_workspace_layout_error = error;
      }
    },
  );
}

/** Record a failed attempt while allowing a later process/startup to retry it. */
export function failWorkspaceLayoutPreparation<T>(promise: Promise<T>, error: unknown): void {
  if (global.__flujo_workspace_migration_promise !== promise) return;
  global.__flujo_workspace_migration_promise = undefined;
  global.__flujo_workspace_layout_status = 'failed';
  global.__flujo_workspace_layout_error = error;
}

/**
 * Await the startup-owned migration without importing its implementation. With
 * `wait`, a request that arrives before startup has begun preparing the layout
 * waits for it to begin instead of being refused at once.
 */
export async function waitForWorkspaceLayoutReady(wait?: StartupWait): Promise<void> {
  if (wait && !getWorkspaceLayoutPreparation() && getWorkspaceLayoutStatus() === 'not-started') {
    await waitForStartup(() => getWorkspaceLayoutPreparation() !== undefined || getWorkspaceLayoutStatus() !== 'not-started', wait);
  }
  const promise = getWorkspaceLayoutPreparation();
  if (!promise) {
    if (getWorkspaceLayoutStatus() === 'failed') {
      throw global.__flujo_workspace_layout_error ?? new Error('Workspace layout preparation failed.');
    }
    throw new WorkspaceLayoutNotStartedError();
  }
  await promise;
}
