import { AsyncLocalStorage } from 'node:async_hooks';
import { getCurrentWorkspace, normalizeWorkspaceName, runWithWorkspace } from '@/utils/workspace';

interface WorkspaceGateState {
  activeMutations: number;
  blocked: boolean;
  generation: number;
  admissionWaiters: Set<() => void>;
  drainWaiters: Set<() => void>;
}

interface MutationAdmission {
  participants: number;
  waiters: Set<() => void>;
  recovery?: { signal?: AbortSignal; assertOwned(): Promise<void> };
}
interface MutationParticipant { live: boolean; admission: MutationAdmission }
interface WorkspaceMutationContext {
  participants: Map<string, MutationParticipant>;
  readCaptures?: Set<string>;
}

export interface WorkspaceRecoveryOperation {
  readonly workspace: string;
  readonly generation: number;
  assertOwned(): Promise<void>;
}

function contextError(recovery: boolean, reason: string): Error {
  const error = new Error(`Workspace ${recovery ? 'recovery' : 'mutation'} ${reason}.`);
  error.name = recovery ? 'WorkspaceRecoveryOwnershipError' : 'WorkspaceMutationContextError';
  return error;
}

async function participate<T>(
  workspace: string, admission: MutationAdmission,
  task: (participant: MutationParticipant) => Promise<T>,
): Promise<T> {
  const participant = { live: true, admission };
  admission.participants += 1;
  const participants = new Map(mutationContext.getStore()?.participants ?? []);
  participants.set(workspace, participant);
  try {
    return await runWithWorkspace(workspace, () => mutationContext.run({ participants, readCaptures: mutationContext.getStore()?.readCaptures }, () => task(participant)));
  } finally {
    participant.live = false;
    admission.participants -= 1;
    if (admission.participants === 0) {
      for (const resolve of admission.waiters) resolve();
      admission.waiters.clear();
    }
  }
}

async function drain(admission: MutationAdmission): Promise<void> {
  if (admission.participants > 0) await new Promise<void>(resolve => admission.waiters.add(resolve));
}

async function checkParticipant(workspace: string, participant: MutationParticipant): Promise<void> {
  const recovery = participant.admission.recovery;
  const check = () => {
    if (!participant.live) throw contextError(!!recovery, 'context has finished');
    if (getCurrentWorkspace() !== workspace) throw contextError(!!recovery, 'workspace changed');
    if (recovery?.signal?.aborted) throw contextError(true, 'was cancelled');
  };
  check();
  if (recovery) {
    try { await recovery.assertOwned(); }
    catch { throw contextError(true, 'ownership was lost'); }
    check();
  }
}

/** Revalidate an admitted write after awaits and immediately before publication. */
export async function assertWorkspaceMutationOwned(): Promise<void> {
  const workspace = normalizeWorkspaceName(getCurrentWorkspace());
  const participant = mutationContext.getStore()?.participants?.get(workspace);
  if (!participant) throw contextError(false, 'has no admitted participant');
  await checkParticipant(workspace, participant);
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
  // A hot-reloaded process can retain the predecessor's workspaces-only store.
  // Its inherited Set is never authority to join a current admission.
  if (current && !current.participants) throw contextError(false, 'context predates the current admission protocol');
  if (current?.readCaptures?.has(normalizedWorkspace)) throw contextError(false, 'cannot write from a read capture');
  const inherited = current?.participants?.get(normalizedWorkspace);
  if (inherited) {
    return runWithWorkspace(normalizedWorkspace, async () => {
      await checkParticipant(normalizedWorkspace, inherited);
      // Ownership verification can yield. Never create a child from a retired token.
      if (!inherited.live) throw contextError(!!inherited.admission.recovery, 'context has finished');
      return participate(normalizedWorkspace, inherited.admission, async participant => {
        await checkParticipant(normalizedWorkspace, participant);
        const result = await task();
        await checkParticipant(normalizedWorkspace, participant);
        return result;
      });
    });
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

  const admission: MutationAdmission = { participants: 0, waiters: new Set() };

  try {
    // Import lazily: the filesystem lock primitive itself uses storage helpers
    // that import this gate. Its admission path deliberately avoids write queues.
    const { withWorkspaceProcessMutation } = await import('../enduringAgents/runtimeLock');
    return await runWithWorkspace(normalizedWorkspace, () => withWorkspaceProcessMutation(
      async () => {
        try { return await participate(normalizedWorkspace, admission, task); }
        finally { await drain(admission); }
      },
    ));
  } finally {
    state.activeMutations -= 1;
    notifyDrain(state);
  }
}

/** Exclusive writes borrow the held physical capture admission, never reopen it. */
export async function withWorkspaceRecoveryMutation<T>(
  task: (operation: WorkspaceRecoveryOperation) => Promise<T>,
  options: { workspace?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const workspace = normalizeWorkspaceName(options.workspace ?? getCurrentWorkspace());
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = performance.now();
  if (signal?.aborted) throw contextError(true, 'was cancelled');
  let boundary: WorkspaceSnapshotBoundary;
  try { boundary = await beginWorkspaceSnapshotBoundary(workspace, timeoutMs, signal, true); }
  catch (error) {
    if (signal?.aborted) throw contextError(true, 'was cancelled');
    throw error;
  }
  try {
    const { withWorkspaceProcessSnapshot } = await import('../enduringAgents/runtimeLock');
    return await runWithWorkspace(workspace, () => withWorkspaceProcessSnapshot(async lock => {
      const admission: MutationAdmission = { participants: 0, waiters: new Set(), recovery: { signal, assertOwned: () => lock.assertOwned() } };
      try {
        const result = await participate(workspace, admission, async participant => {
          const operation = Object.freeze({ workspace, generation: boundary.generation, assertOwned: () => checkParticipant(workspace, participant) });
          await operation.assertOwned();
          const value = await task(operation);
          await operation.assertOwned();
          return value;
        });
        await drain(admission);
        if (signal?.aborted) throw contextError(true, 'was cancelled');
        try { await lock.assertOwned(); } catch { throw contextError(true, 'ownership was lost'); }
        if (signal?.aborted) throw contextError(true, 'was cancelled');
        return result;
      } finally { await drain(admission); }
    }, { signal, timeoutMs: Math.max(1, timeoutMs - (performance.now() - started)) }));
  } catch (error) {
    if (signal?.aborted) throw contextError(true, 'was cancelled');
    throw error;
  } finally { boundary.release(); }
}

/** A coherent capture for registered writers in all processes on this workspace. */
export async function withWorkspaceRecoveryCapture<T>(
  task: (generation: number) => Promise<T>,
  options: { workspace?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const workspace = normalizeWorkspaceName(options.workspace ?? getCurrentWorkspace());
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = performance.now();
  const boundary = await beginWorkspaceSnapshotBoundary(workspace, timeoutMs, signal, true);
  try {
    const { withWorkspaceProcessSnapshot } = await import('../enduringAgents/runtimeLock');
    return await runWithWorkspace(workspace, () => withWorkspaceProcessSnapshot(
      () => {
        const current = mutationContext.getStore();
        const readCaptures = new Set(current?.readCaptures ?? []);
        readCaptures.add(workspace);
        return mutationContext.run({ participants: new Map(current?.participants ?? []), readCaptures }, () => task(boundary.generation));
      },
      { signal, timeoutMs: Math.max(1, timeoutMs - (performance.now() - started)) },
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
  retainAfterAdmission = false,
): Promise<WorkspaceSnapshotBoundary> {
  signal?.throwIfAborted();
  const normalizedWorkspace = normalizeWorkspaceName(workspace);
  const current = mutationContext.getStore();
  if (current && !current.participants) throw contextError(false, 'context predates the current admission protocol');
  if (current?.participants?.has(normalizedWorkspace)) {
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
  let admitted = false;
  const release = (): void => {
    if (released) return;
    released = true;
    signal?.removeEventListener('abort', onAbort);
    unblock(state);
  };
  const onAbort = (): void => {
    if (admitted && retainAfterAdmission) return;
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
  admitted = true;
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
