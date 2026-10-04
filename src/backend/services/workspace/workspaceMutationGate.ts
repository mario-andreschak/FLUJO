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
  recovery?: boolean;
  assertOwned?: () => Promise<void>;
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

interface WorkspaceRecoveryOptions {
  workspace?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WorkspaceRecoveryMutation {
  readonly workspace: string;
  /** Local capture counter, not a durable credential generation. */
  readonly generation: number;
  assertOwned(): Promise<void>;
}

export class WorkspaceRecoveryMutationError extends Error {
  constructor(readonly code: 'RECOVERY_FINISHED' | 'RECOVERY_CANCELLED' | 'RECOVERY_WORKSPACE' | 'RECOVERY_OWNERSHIP') {
    const messages = {
      RECOVERY_FINISHED: 'Recovery write admission has finished; start a new recovery operation.',
      RECOVERY_CANCELLED: 'Recovery write was cancelled; inspect its journal before resuming or rolling back.',
      RECOVERY_WORKSPACE: 'Recovery write belongs to another workspace.',
      RECOVERY_OWNERSHIP: 'Recovery write ownership was lost; inspect its journal before resuming or rolling back.',
    };
    super(messages[code]);
    this.name = 'WorkspaceRecoveryMutationError';
  }
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
    if (lease.assertOwned) await lease.assertOwned();
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
    return runWithWorkspace(normalizedWorkspace, () => participate(inherited, task));
  }
  if (inherited?.recovery) {
    // A late recovery descendant may still hold staged values for an old
    // transaction. It must not turn those into an ordinary fresh mutation.
    throw new WorkspaceRecoveryMutationError('RECOVERY_FINISHED');
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
async function withWorkspaceRecoveryBoundary<T>(
  task: (generation: number, assertOwned: () => Promise<void>) => Promise<T>,
  options: WorkspaceRecoveryOptions,
): Promise<T> {
  const workspace = normalizeWorkspaceName(options.workspace ?? getCurrentWorkspace());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = performance.now();
  const boundary = await beginWorkspaceSnapshotBoundary(workspace, timeoutMs, options.signal);
  try {
    const { withWorkspaceProcessSnapshot } = await import('../enduringAgents/runtimeLock');
    return await runWithWorkspace(workspace, () => withWorkspaceProcessSnapshot(
      lock => task(boundary.generation, () => lock.assertOwned()),
      { signal: options.signal, timeoutMs: Math.max(1, timeoutMs - (performance.now() - started)) },
    ));
  } finally {
    boundary.release();
  }
}

/** Read capture grants no nested write admission. */
export function withWorkspaceRecoveryCapture<T>(
  task: (generation: number) => Promise<T>,
  options: WorkspaceRecoveryOptions = {},
): Promise<T> {
  return withWorkspaceRecoveryBoundary(generation => task(generation), options);
}

/**
 * Explicit recovery writes after draining registered writers in every process.
 * Only this operation's selected workspace may borrow the held admission.
 * Callers must supply the durable journal/backup/commit protocol separately.
 */
export function withWorkspaceRecoveryMutation<T>(
  task: (operation: WorkspaceRecoveryMutation) => Promise<T>,
  options: WorkspaceRecoveryOptions = {},
): Promise<T> {
  const workspace = normalizeWorkspaceName(options.workspace ?? getCurrentWorkspace());
  const signal = options.signal;
  return withWorkspaceRecoveryBoundary(async (generation, assertProcessOwned) => {
    const lease = createMutationLease();
    lease.recovery = true;
    const checkState = (requireLive: boolean) => {
      if (requireLive && !lease.active) throw new WorkspaceRecoveryMutationError('RECOVERY_FINISHED');
      if (signal?.aborted) throw new WorkspaceRecoveryMutationError('RECOVERY_CANCELLED');
      if (getCurrentWorkspace() !== workspace) throw new WorkspaceRecoveryMutationError('RECOVERY_WORKSPACE');
    };
    const checkOwned = async (requireLive = true) => {
      checkState(requireLive);
      try { await assertProcessOwned(); }
      catch {
        checkState(requireLive);
        throw new WorkspaceRecoveryMutationError('RECOVERY_OWNERSHIP');
      }
      checkState(requireLive);
    };
    lease.assertOwned = () => checkOwned();
    const nextContext: WorkspaceMutationContext = { leases: new Map(mutationContext.getStore()?.leases ?? []) };
    nextContext.leases.set(workspace, lease);
    const operation = Object.freeze({ workspace, generation, assertOwned: lease.assertOwned });
    return mutationContext.run(nextContext, async () => {
      let result: T;
      try { result = await participate(lease, () => task(operation)); }
      finally { await lease.drained; }
      // The public capability has retired. Recheck the still-held physical
      // owner and cancellation before acknowledging settled recovery writes.
      await checkOwned(false);
      return result;
    });
  }, { ...options, workspace, signal }).catch(error => {
    // The same fixed cancellation applies while initially draining/acquiring;
    // caller-supplied abort reasons never become recovery diagnostics.
    if (signal?.aborted) throw new WorkspaceRecoveryMutationError('RECOVERY_CANCELLED');
    throw error;
  });
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
