import { AsyncLocalStorage } from 'node:async_hooks';
import { getCurrentWorkspace, normalizeWorkspaceName, runWithWorkspace } from '@/utils/workspace';

interface WorkspaceGateState {
  activeMutations: number;
  blocked: boolean;
  generation: number;
  admissionWaiters: Set<() => void>;
  drainWaiters: Set<() => void>;
}

interface WorkspaceMutationLease {
  active: boolean;
  participants: number;
  drained: Promise<void>;
  resolveDrained(): void;
}

interface WorkspaceMutationContext {
  leases: Map<string, WorkspaceMutationLease>;
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

function createMutationLease(): WorkspaceMutationLease {
  let resolveDrained!: () => void;
  const drained = new Promise<void>(resolve => { resolveDrained = resolve; });
  return { active: true, participants: 0, drained, resolveDrained };
}

/** Retain the owning process registration until every started nested call settles. */
async function participate<T>(lease: WorkspaceMutationLease, task: () => Promise<T>): Promise<T> {
  lease.participants += 1;
  try {
    return await task();
  } finally {
    lease.participants -= 1;
    if (lease.participants === 0) {
      lease.active = false;
      lease.resolveDrained();
    }
  }
}

/**
 * Admit one FLUJO-managed workspace mutation. Calls nested inside the same
 * workspace mutation borrow its live admission. The owner retains both gates
 * until started nested calls settle. An inherited async context alone grants
 * no admission after that lease retires.
 */
export async function withWorkspaceMutation<T>(
  task: () => Promise<T>,
  workspace = getCurrentWorkspace(),
): Promise<T> {
  const normalizedWorkspace = normalizeWorkspaceName(workspace);
  const current = mutationContext.getStore();
  // Optional lookup also refuses privilege inherited from a pre-upgrade HMR
  // context, which has workspace names but no live lease.
  const inherited = current?.leases?.get(normalizedWorkspace);
  if (inherited?.active) {
    return participate(inherited, () => runWithWorkspace(normalizedWorkspace, task));
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

  const lease = createMutationLease();
  const nextContext: WorkspaceMutationContext = { leases: new Map(current?.leases ?? []) };
  nextContext.leases.set(normalizedWorkspace, lease);

  try {
    // Import lazily: the filesystem lock primitive itself uses storage helpers
    // that import this gate. Its admission path deliberately avoids write queues.
    const { withWorkspaceProcessMutation } = await import('../enduringAgents/runtimeLock');
    return await runWithWorkspace(normalizedWorkspace, () => withWorkspaceProcessMutation(
      () => mutationContext.run(nextContext, async () => {
        try { return await participate(lease, task); }
        finally { await lease.drained; }
      }),
    ));
  } finally {
    // A registration failure never publishes this context, but still retires
    // its owned lease. Inherited contexts can never reuse a finished owner.
    lease.active = false;
    state.activeMutations -= 1;
    notifyDrain(state);
  }
}

/** A coherent capture for registered writers in all processes on this workspace. */
export async function withWorkspaceRecoveryCapture<T>(
  task: (generation: number) => Promise<T>,
  options: { workspace?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const workspace = normalizeWorkspaceName(options.workspace ?? getCurrentWorkspace());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = performance.now();
  const boundary = await beginWorkspaceSnapshotBoundary(workspace, timeoutMs, options.signal);
  try {
    const { withWorkspaceProcessSnapshot } = await import('../enduringAgents/runtimeLock');
    return await runWithWorkspace(workspace, () => withWorkspaceProcessSnapshot(
      () => task(boundary.generation),
      { signal: options.signal, timeoutMs: Math.max(1, timeoutMs - (performance.now() - started)) },
    ));
  } finally {
    boundary.release();
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
  if (current?.leases?.get(normalizedWorkspace)?.active) {
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
