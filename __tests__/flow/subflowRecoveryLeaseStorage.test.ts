import os from 'node:os';
import path from 'node:path';
import { promises as fs, type BigIntStats } from 'node:fs';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import * as persistence from '@/backend/execution/flow/persistConversationState';
import { reportSubflowRunOutcome, type SubflowRunOutcome } from '@/backend/execution/flow/subflowRecovery';
import { getCurrentWorkspace, getWorkspaceDbDir, runWithWorkspace, workspaceCacheKey } from '@/utils/workspace';
import type { SharedState, SubflowInvocation } from '@/backend/execution/flow/types';

const runFlowMock = jest.fn<Promise<SubflowRunOutcome>, [unknown]>();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (input: unknown) => runFlowMock(input),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const fixturePrefix = 'flujo-resume-lease-';
interface FixtureIdentity {
  root: string;
  parent: string;
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  parentDev: bigint;
  parentIno: bigint;
  parentBirthtimeNs: bigint;
}

async function captureFixture(root: string, parent: string): Promise<FixtureIdentity> {
  const resolved = path.resolve(root);
  const relative = path.relative(parent, resolved);
  if (!path.isAbsolute(root) || relative !== path.basename(resolved)
      || !relative.startsWith(fixturePrefix) || relative.length <= fixturePrefix.length) {
    throw new Error('Fixture is outside its exact owned temporary parent');
  }
  const parentStat = await fs.lstat(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await fs.realpath(parent) !== parent) {
    throw new Error('Fixture parent is not a plain canonical directory');
  }
  const stat = await fs.lstat(resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(resolved) !== resolved) {
    throw new Error('Fixture root is not a plain canonical directory');
  }
  return { root: resolved, parent, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs,
    parentDev: parentStat.dev, parentIno: parentStat.ino, parentBirthtimeNs: parentStat.birthtimeNs };
}

async function verifyOwnedFixture(identity: FixtureIdentity): Promise<void> {
  const current = await captureFixture(identity.root, identity.parent);
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs
      || current.parentDev !== identity.parentDev || current.parentIno !== identity.parentIno
      || current.parentBirthtimeNs !== identity.parentBirthtimeNs) {
    throw new Error('Preserving replaced fixture root');
  }
}

async function removeOwnedFixture(identity: FixtureIdentity, hasPendingOwner: () => boolean): Promise<void> {
  if (hasPendingOwner()) throw new Error('Preserving fixture with pending recovery ownership');
  await verifyOwnedFixture(identity);
  if (hasPendingOwner()) throw new Error('Preserving fixture with pending recovery ownership');
  await fs.rm(identity.root, { recursive: true, force: false });
}

async function withIndependentCleanup(
  task: () => Promise<void>, steps: Array<() => void | Promise<void>>, faultContext: () => unknown[] = () => [],
): Promise<void> {
  const errors: unknown[] = [];
  try { await task(); } catch (error) { errors.push(error); }
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length) errors.unshift(...faultContext());
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Recovery fixture operation and cleanup failed');
}

async function assertAbsent(file: string): Promise<void> {
  try { await fs.lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Preserving occupied restoration destination');
}

function family(): { parent: SharedState; outcome: SubflowRunOutcome } {
  const invocation: SubflowInvocation = {
    version: 1, id: 'lease-invocation', parentConversationId: 'lease-parent',
    parentNodeId: 'sub-node', status: 'blocked', depth: 1, showSteps: true,
    concurrencyLimit: 1, joinSeparator: '\n', errorStrategy: 'fail-fast',
    lanes: [{ id: 'lane', index: 0, count: 1, subflowId: 'child-flow',
      conversationId: 'lease-child', status: 'error', attempt: 1, updatedAt: 1 }],
    createdAt: 1, updatedAt: 1,
  };
  const parent = {
    logicalRunId: 'lease-parent-run', conversationId: 'lease-parent', flowId: 'parent-flow',
    currentNodeId: 'sub-node', status: 'error', source: 'chat', title: 'Lease fixture',
    createdAt: 1, updatedAt: 1, messages: [],
    trackingInfo: { executionId: 'parent-exec', startTime: 1, nodeExecutionTracker: [] },
    subflowInvocations: { [invocation.id]: invocation },
    activeSubflowInvocationByNode: { 'sub-node': invocation.id },
  } as SharedState;
  FlowExecutor.conversationStates.set('lease-parent', parent);
  const child = {
    conversationId: 'lease-child', parentConversationId: 'lease-parent', messages: [],
    subflowLane: { invocationId: invocation.id, laneId: 'lane', conversationId: 'lease-child' },
  } as unknown as SharedState;
  return { parent, outcome: { status: 'completed', conversationId: 'lease-child',
    outputText: 'durable child output', sharedState: child } };
}

describe('parent resume lease with real storage', () => {
  const workspaces = ['lease-storage-a', 'lease-storage-b'];
  const persist = persistence.persistConversationState;
  let root: string;
  let identity: FixtureIdentity;
  const pendingReports = new Set<Promise<void>>();
  // Keep failures by original root, even if a later test creates a new fixture.
  // Expected task faults do not enter this ledger: only real cleanup steps do.
  const fixtureCleanupFailures = new Map<string, Map<string, unknown>>();
  let priorData: string | undefined;
  let priorParentData: string | undefined;

  const hasPendingOwner = () => pendingReports.size > 0 || workspaces.some(workspace =>
    runWithWorkspace(workspace, () => global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation')) ?? false));
  const reportOutcome = (outcome: SubflowRunOutcome) => {
    const report = reportSubflowRunOutcome(outcome);
    pendingReports.add(report);
    // Observe settlement without creating an unhandled rejected cleanup promise.
    void report.then(() => pendingReports.delete(report), () => pendingReports.delete(report));
    return report;
  };

  const ownedCleanupStep = (name: string, step: () => Promise<void>) => {
    const fixtureRoot = root;
    return async () => {
      const failures = fixtureCleanupFailures.get(fixtureRoot)!;
      try {
        await step();
        failures.delete(name); // Only successful recovery of this step clears it.
      } catch (error) {
        failures.set(name, error);
        throw error;
      }
    };
  };

  const removeSnapshotBlocker = async (target: string, original: BigIntStats) => {
    if (hasPendingOwner()) throw new Error('Preserving snapshot with pending recovery ownership');
    await verifyOwnedFixture(identity);
    const relative = path.relative(identity.root, path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Snapshot cleanup escapes fixture');
    const parent = path.dirname(path.resolve(target));
    if ((await fs.lstat(parent)).isSymbolicLink() || await fs.realpath(parent) !== parent) {
      throw new Error('Preserving redirected snapshot parent');
    }
    const current = await fs.lstat(target, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev
        || current.ino !== original.ino || current.birthtimeNs !== original.birthtimeNs) {
      throw new Error('Preserving replaced snapshot blocker');
    }
    if (hasPendingOwner()) throw new Error('Preserving snapshot with pending recovery ownership');
    await fs.rmdir(target);
  };

  beforeEach(async () => {
    if (hasPendingOwner()) throw new Error('Prior fixture still has recovery ownership; preserving it');
    const temporaryParent = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(temporaryParent, fixturePrefix));
    identity = await captureFixture(root, temporaryParent);
    fixtureCleanupFailures.set(root, new Map());
    priorData = process.env.FLUJO_DATA_DIR;
    priorParentData = process.env.FLUJO_PARENT_DATA_DIR;
    process.env.FLUJO_DATA_DIR = root;
    delete process.env.FLUJO_PARENT_DATA_DIR;
    runFlowMock.mockReset();
    for (const workspace of workspaces) runWithWorkspace(workspace, () => FlowExecutor.conversationStates.clear());
    runFlowMock.mockImplementation(async () => ({ status: 'completed', conversationId: 'lease-parent',
      outputText: 'parent output', sharedState: FlowExecutor.conversationStates.get('lease-parent')! }));
  });

  const cleanupFixture = async () => {
    // Do not restore mocks/env, clear live state, or remove data beneath an
    // unsettled writer. Preserve the fixture and make that uncertainty fail.
    if (hasPendingOwner()) throw new Error(`Pending recovery ownership; fixture preserved at ${root}`);
    await withIndependentCleanup(async () => {
      const failures = fixtureCleanupFailures.get(root)!;
      if (failures.size) {
        throw new AggregateError([...failures.values()], `Unresolved cleanup steps; fixture preserved at ${root}`);
      }
      await ownedCleanupStep('fixture-root', () => removeOwnedFixture(identity, hasPendingOwner))();
      fixtureCleanupFailures.delete(root);
    }, [
      () => { jest.restoreAllMocks(); },
      ...workspaces.map(workspace => () => runWithWorkspace(workspace, () => FlowExecutor.conversationStates.clear())),
      () => {
        if (priorData === undefined) delete process.env.FLUJO_DATA_DIR;
        else process.env.FLUJO_DATA_DIR = priorData;
      },
      () => {
        if (priorParentData === undefined) delete process.env.FLUJO_PARENT_DATA_DIR;
        else process.env.FLUJO_PARENT_DATA_DIR = priorParentData;
      },
    ]);
  };

  afterEach(cleanupFixture);

  it('preserves a replaced snapshot sentinel through teardown until actual owned cleanup recovers', async () => {
    const target = path.join(root, 'workspaces', workspaces[0], 'db', 'conversations', 'replacement.json');
    const displaced = `${target}.original`;
    await verifyOwnedFixture(identity);
    await fs.mkdir(target, { recursive: true });
    const original = await fs.lstat(target, { bigint: true });
    await fs.rename(target, displaced);
    await fs.mkdir(target);
    const replacement = await fs.lstat(target, { bigint: true });
    const sentinel = path.join(target, 'foreign-sentinel.txt');
    await fs.writeFile(sentinel, 'must survive teardown');
    const cleanup = ownedCleanupStep('snapshot-blocker', () => removeSnapshotBlocker(target, original));
    await expect(cleanup()).rejects.toThrow('replaced snapshot blocker');
    await expect(cleanupFixture()).rejects.toThrow('Unresolved cleanup steps');
    expect(await fs.readFile(sentinel, 'utf8')).toBe('must survive teardown');
    expect(fixtureCleanupFailures.get(root)?.has('snapshot-blocker')).toBe(true);
    expect(process.env.FLUJO_DATA_DIR).toBe(priorData);
    expect(process.env.FLUJO_PARENT_DATA_DIR).toBe(priorParentData);
    // This control owns the replacement too. Recover it with its separately
    // captured identity, without deleting any unrecognized replacement.
    await verifyOwnedFixture(identity);
    const current = await fs.lstat(target, { bigint: true });
    expect(current.dev).toBe(replacement.dev);
    expect(current.ino).toBe(replacement.ino);
    expect(current.birthtimeNs).toBe(replacement.birthtimeNs);
    await fs.unlink(sentinel);
    await removeSnapshotBlocker(target, replacement);
    await assertAbsent(target);
    const displacedIdentity = await fs.lstat(displaced, { bigint: true });
    expect(displacedIdentity.isDirectory() && !displacedIdentity.isSymbolicLink()).toBe(true);
    expect(displacedIdentity.dev).toBe(original.dev);
    expect(displacedIdentity.ino).toBe(original.ino);
    expect(displacedIdentity.birthtimeNs).toBe(original.birthtimeNs);
    await fs.rename(displaced, target);
    await cleanup();
    expect(fixtureCleanupFailures.get(root)?.size).toBe(0);
  });

  it('retains the primary refusal and each independent restoration failure while attempting later steps', async () => {
    const primary = new Error('primary removal refusal');
    const clearFailure = new Error('workspace clear failed');
    const restoreFailure = new Error('first environment restoration failed');
    const observed: string[] = [];
    const failure: unknown = await withIndependentCleanup(async () => { throw primary; }, [
      () => { observed.push('clear'); throw clearFailure; },
      () => { observed.push('env-data'); throw restoreFailure; },
      () => { observed.push('env-parent'); },
    ]).catch(error => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, clearFailure, restoreFailure]);
    expect(observed).toEqual(['clear', 'env-data', 'env-parent']);
  });

  it('preserves a lone primary error after all restoration steps succeed', async () => {
    const primary = new Error('original fault assertion');
    const restored: string[] = [];
    await expect(withIndependentCleanup(async () => { throw primary; }, [
      () => { restored.push('remove-blocker'); },
      () => { restored.push('restore-snapshot'); },
    ])).rejects.toBe(primary);
    expect(restored).toEqual(['remove-blocker', 'restore-snapshot']);
  });

  it('refuses recursive cleanup outside the captured temporary parent or with a pending owner', async () => {
    await expect(removeOwnedFixture({ ...identity, root: identity.parent }, () => false))
      .rejects.toThrow('outside its exact owned temporary parent');
    await expect(removeOwnedFixture(identity, () => true)).rejects.toThrow('pending recovery ownership');
    expect((await fs.lstat(root)).isDirectory()).toBe(true);
  });

  it('preserves a real replacement directory rather than deleting it under the original identity', async () => {
    const displaced = `${root}-displaced`;
    // Verify the computed source and destination before moving the owned root.
    await captureFixture(root, identity.parent);
    expect(path.dirname(displaced)).toBe(identity.parent);
    expect(path.basename(displaced).startsWith(fixturePrefix)).toBe(true);
    await fs.rename(root, displaced);
    let replacement: FixtureIdentity | undefined;
    await withIndependentCleanup(async () => {
      await fs.mkdir(root);
      replacement = await captureFixture(root, identity.parent);
      await fs.writeFile(path.join(root, 'replacement-proof.txt'), 'preserve me');
      await expect(removeOwnedFixture(identity, () => false)).rejects.toThrow('replaced fixture root');
      expect(await fs.readFile(path.join(root, 'replacement-proof.txt'), 'utf8')).toBe('preserve me');
    }, [
      ownedCleanupStep('replacement-root', async () => { if (replacement) await removeOwnedFixture(replacement, () => false); }),
      ownedCleanupStep('restore-original-root', async () => {
        const original = await captureFixture(displaced, identity.parent);
        expect(original.dev).toBe(identity.dev);
        expect(original.ino).toBe(identity.ino);
        expect(original.birthtimeNs).toBe(identity.birthtimeNs);
        // Both resolved paths remain direct children of the captured owned parent.
        expect(path.dirname(path.resolve(root))).toBe(identity.parent);
        await assertAbsent(root);
        await fs.rename(displaced, root);
      }),
    ]);
  });

  it('releases its lease after an actual resume-snapshot filesystem failure and permits reacquisition', async () => {
    await runWithWorkspace(workspaces[0], async () => {
      const { parent, outcome } = family();
      const target = path.join(getWorkspaceDbDir(), 'conversations', 'lease-parent.json');
      const backup = `${target}.fixture-backup`;
      let writes = 0;
      let storageFailure: unknown;
      let backupIdentity: BigIntStats | undefined;
      let blockerIdentity: BigIntStats | undefined;
      const verifyRestoration = async () => {
        if (hasPendingOwner()) throw new Error('Preserving snapshot with pending recovery ownership');
        await verifyOwnedFixture(identity);
        for (const file of [target, backup]) {
          const relative = path.relative(identity.root, path.resolve(file));
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Snapshot restoration escapes fixture');
        }
      };
      jest.spyOn(persistence, 'persistConversationState').mockImplementation(async (key, state) => {
        if (++writes === 2) {
          // The child-result write has succeeded. Block only the subsequent
          // leased resume snapshot, using the real atomic storage writer.
          await fs.rename(target, backup);
          backupIdentity = await fs.lstat(backup, { bigint: true });
          await fs.mkdir(target);
          blockerIdentity = await fs.lstat(target, { bigint: true });
        }
        await persist(key, state);
      });
      await withIndependentCleanup(async () => {
        const failure: unknown = await reportOutcome(outcome).then(
          () => { throw new Error('The blocked snapshot unexpectedly persisted'); },
          error => error,
        );
        storageFailure = failure;
        expect(['EISDIR', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST']).toContain((failure as NodeJS.ErrnoException).code);
        expect(writes).toBe(2);
        expect(runFlowMock).not.toHaveBeenCalled();
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(false);
        const saved = JSON.parse(await fs.readFile(backup, 'utf8')) as SharedState;
        expect(saved.subflowInvocations?.['lease-invocation'].lanes[0].outputText).toBe(outcome.outputText);
      }, [
        ownedCleanupStep('snapshot-blocker', async () => {
          if (!blockerIdentity) return;
          await verifyRestoration();
          await removeSnapshotBlocker(target, blockerIdentity);
        }),
        ownedCleanupStep('restore-snapshot-backup', async () => {
          if (!backupIdentity) return;
          await verifyRestoration();
          const current = await fs.lstat(backup, { bigint: true });
          if (!current.isFile() || current.isSymbolicLink() || current.dev !== backupIdentity.dev
              || current.ino !== backupIdentity.ino || current.birthtimeNs !== backupIdentity.birthtimeNs
              || current.size !== backupIdentity.size || current.mtimeNs !== backupIdentity.mtimeNs) {
            throw new Error('Preserving replaced snapshot backup');
          }
          await assertAbsent(target);
          await fs.rename(backup, target);
        }),
      ], () => storageFailure === undefined ? [] : [storageFailure]);
      await reportOutcome(outcome);
      expect(runFlowMock).toHaveBeenCalledTimes(1);
      expect(parent.subflowInvocations?.['lease-invocation'].resumeRequestedAt).toEqual(expect.any(Number));
      const saved = JSON.parse(await fs.readFile(target, 'utf8')) as SharedState;
      expect(saved.subflowInvocations?.['lease-invocation'].lanes[0].outputText).toBe(outcome.outputText);
    });
  });

  it('keeps the lease during pending persistence and continuation despite duplicate outcomes', async () => {
    await runWithWorkspace(workspaces[0], async () => {
      const { outcome } = family();
      const persisting = deferred();
      const allowPersist = deferred();
      const continuing = deferred();
      const allowContinuation = deferred();
      let writes = 0;
      jest.spyOn(persistence, 'persistConversationState').mockImplementation(async (key, state) => {
        if (++writes === 2) { persisting.resolve(); await allowPersist.promise; }
        await persist(key, state);
      });
      runFlowMock.mockImplementationOnce(async () => {
        continuing.resolve();
        await allowContinuation.promise;
        return { status: 'completed', conversationId: 'lease-parent', outputText: 'done',
          sharedState: FlowExecutor.conversationStates.get('lease-parent')! };
      });
      const first = reportOutcome(outcome);
      await withIndependentCleanup(async () => {
        await persisting.promise;
        await reportOutcome(outcome);
        expect(runFlowMock).not.toHaveBeenCalled();
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(true);
        allowPersist.resolve();
        await continuing.promise;
        await reportOutcome(outcome);
        expect(runFlowMock).toHaveBeenCalledTimes(1);
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(true);
      }, [
        () => { allowPersist.resolve(); },
        () => { allowContinuation.resolve(); },
        async () => { await first; },
      ]);
    });
  });

  it('allows the same invocation in another workspace while the first workspace owns its lease', async () => {
    const entered = deferred();
    const release = deferred();
    const observed: string[] = [];
    runFlowMock.mockImplementation(async () => {
      const workspace = getCurrentWorkspace();
      observed.push(workspace);
      if (workspace === workspaces[0]) { entered.resolve(); await release.promise; }
      return { status: 'completed', conversationId: 'lease-parent', outputText: workspace,
        sharedState: FlowExecutor.conversationStates.get('lease-parent')! };
    });
    const first = runWithWorkspace(workspaces[0], () => reportOutcome(family().outcome));
    await withIndependentCleanup(async () => {
      await entered.promise;
      await runWithWorkspace(workspaces[1], async () => {
        const { outcome } = family();
        await reportOutcome(outcome);
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(false);
        const saved = JSON.parse(await fs.readFile(path.join(getWorkspaceDbDir(), 'conversations', 'lease-parent.json'), 'utf8')) as SharedState;
        expect(saved.subflowInvocations?.['lease-invocation'].lanes[0].outputText).toBe(outcome.outputText);
      });
      expect(observed).toEqual(workspaces);
      runWithWorkspace(workspaces[0], () => {
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(true);
      });
    }, [() => { release.resolve(); }, async () => { await first; }]);
  });
});
