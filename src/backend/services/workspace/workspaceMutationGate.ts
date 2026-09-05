import { AsyncLocalStorage } from 'node:async_hooks';
import { getCurrentWorkspace, normalizeWorkspaceName } from '@/utils/workspace';

interface WorkspaceGateState {
  activeMutations: number;
  blocked: boolean;
  generation: number;
  admissionWaiters: Set<() => void>;
  drainWaiters: Set<() => void>;
}

interface WorkspaceMutationContext {
  workspaces: Set<string>;
}

export interface WorkspaceSnapshotBoundary {
  generation: number;
  release(): void;
}

declare global {
  var __flujoWorkspaceMutationGates: Map<string, WorkspaceGateState> | undefined;
  var __flujoWorkspaceMutationContext:
    | AsyncLocalStorage<WorkspaceMutationContext>
    | undefined;
}

const gates = globalThis.__flujoWorkspaceMutationGates
  ?? (globalThis.__flujoWorkspaceMutationGates = new Map());
const mutationContext = globalThis.__flujoWorkspaceMutationContext
  ?? (globalThis.__flujoWorkspaceMutationContext = new AsyncLocalStorage());

function stateFor(workspace: string): WorkspaceGateState {
  let state = gates.get(workspace);
  if (!state) {
    state = {
      activeMutations: 0,
      blocked: false,
      generation: 0,
      admissionWaiters: new Set(),
      drainWaiters: new Set(),
    };
    gates.set(workspace, state);
  }
  return state;
}

function notifyDrain(state: WorkspaceGateState): void {
  if (state.activeMutations !== 0) return;
  const waiters = [...state.drainWaiters];
  state.drainWaiters.clear();
  for (const resolve of waiters) resolve();
}

function unblock(state: WorkspaceGateState): void {
  if (!state.blocked) return;
  state.blocked = false;
  const waiters = [...state.admissionWaiters];
  state.admissionWaiters.clear();
  for (const resolve of waiters) resolve();
}

/**
 * Admit one FLUJO-managed workspace mutation. Calls nested inside the same
 * workspace mutation are re-entrant, so existing per-key queues can compose
 * with the workspace-wide snapshot boundary without deadlocking.
 */
export async function withWorkspaceMutation<T>(
  task: () => Promise<T>,
  workspace = getCurrentWorkspace(),
): Promise<T> {
  const normalizedWorkspace = normalizeWorkspaceName(workspace);
  const current = mutationContext.getStore();
  if (current?.workspaces.has(normalizedWorkspace)) {
    return task();
  }

  const state = stateFor(normalizedWorkspace);
  // Avoid yielding between observing an open gate and incrementing the active
  // count; beginWorkspaceSnapshotBoundary() must see this admission atomically.
  // Keep the final open-gate check and admission in this same continuation.
  // An async helper returning after its check would allow another snapshot to
  // close the gate before this continuation increments the active count.
  while (state.blocked) {
    await new Promise<void>((resolve) => state.admissionWaiters.add(resolve));
  }
  state.activeMutations += 1;

  const nextContext: WorkspaceMutationContext = {
    workspaces: new Set(current?.workspaces ?? []),
  };
  nextContext.workspaces.add(normalizedWorkspace);

  try {
    return await mutationContext.run(nextContext, task);
  } finally {
    state.activeMutations -= 1;
    notifyDrain(state);
  }
}

/**
 * Stop admitting new managed mutations and wait for admitted mutations to
 * drain. The caller owns the boundary until release() is called.
 */
export async function beginWorkspaceSnapshotBoundary(
  workspace = getCurrentWorkspace(),
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshotBoundary> {
  signal?.throwIfAborted();
  const normalizedWorkspace = normalizeWorkspaceName(workspace);
  const current = mutationContext.getStore();
  if (current?.workspaces.has(normalizedWorkspace)) {
    throw new Error('A workspace snapshot cannot begin inside a workspace mutation.');
  }

  const state = stateFor(normalizedWorkspace);
  if (state.blocked) {
    const error = new Error('A workspace snapshot boundary is already active.');
    error.name = 'WorkspaceSnapshotBusyError';
    throw error;
  }

  state.blocked = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let drainWaiter: (() => void) | undefined;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    signal?.removeEventListener('abort', onAbort);
    unblock(state);
  };
  const onAbort = (): void => {
    release();
    rejectAbort?.(signal?.reason ?? new Error('Workspace snapshot was aborted.'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (state.activeMutations > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          drainWaiter = resolve;
          state.drainWaiters.add(resolve);
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new Error('Timed out waiting for workspace mutations to drain.');
            error.name = 'WorkspaceSnapshotTimeoutError';
            reject(error);
          }, timeoutMs);
        }),
        new Promise<never>((_resolve, reject) => { rejectAbort = reject; }),
      ]);
    }
    signal?.throwIfAborted();
  } catch (error) {
    release();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (drainWaiter) state.drainWaiters.delete(drainWaiter);
  }

  state.generation += 1;
  return {
    generation: state.generation,
    release,
  };
}

/** Visible for status reporting and focused tests. */
export function workspaceMutationStatus(workspace = getCurrentWorkspace()): {
  activeMutations: number;
  blocked: boolean;
  generation: number;
} {
  const state = stateFor(normalizeWorkspaceName(workspace));
  return {
    activeMutations: state.activeMutations,
    blocked: state.blocked,
    generation: state.generation,
  };
}
