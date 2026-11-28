import { resolveBundledFlujoWorkloadRequest, withBundledFlujoWorkloadAuthorization } from '@/backend/services/security/bundledFlujoWorkload';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getCurrentWorkspace } from '@/utils/workspace';
import { attachTrustedHost } from '@/backend/services/mcp/trustedHost';
import { prepareBundledFlujoWorkload, getPendingWorkloadEnvironment } from '@/backend/services/security/bundledFlujoWorkload';
import { APPROVED_BUNDLED_FLUJO_SETUP_MS, installApprovedBundledFlujo, type ApprovedBundledFlujo } from './fixtures/approvedBundledFlujo';
import { unlockPrivateFixtureInCurrentWorkspace } from '../utils/privateProfileFixture';

import { SchedulerService } from '@/backend/services/scheduler';
import { getAuthorizedBundledFlujoWorkloadToolNames, assertBundledFlujoWorkloadEffectCurrent, BundledFlujoWorkloadError } from '@/backend/services/security/bundledFlujoWorkload';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type { PlannedExecutionsFile } from '@/shared/types/plannedExecution';
import { randomUUID } from 'node:crypto';
import { loadExecutionState, saveExecutionState } from '@/backend/services/scheduler/state';

// Real issued capability and durable storage; only timer scheduling and the
// final Flow producer are equipment. This does not claim compiled Flow execution.
let mockReleaseTimer!: () => void;
let mockTimerGate: Promise<void>;
let mockTimerEntered!: () => void;
let mockTimerObserved: Promise<void>;
let mockTimerCompleted: Promise<void> | undefined;
const mockRunFlow = jest.fn(async (..._args: unknown[]) => {
  expect(getAuthorizedBundledFlujoWorkloadToolNames()).toBeUndefined();
  await assertBundledFlujoWorkloadEffectCurrent();
  return { status: 'completed', outputText: 'fixture', messages: [], sharedState: {}, conversationId: 'fixture' };
});
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: (...args: unknown[]) => mockRunFlow(...args) }));
jest.mock('@/backend/services/scheduler/triggers/schedule', () => ({
  ...jest.requireActual('@/backend/services/scheduler/triggers/schedule'),
  armSchedule: (_config: unknown, onFire: (occurrence: Date) => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout>;
    let entered = false;
    let resolveDisposed!: () => void;
    mockTimerCompleted = new Promise<void>((resolve, reject) => {
      resolveDisposed = resolve;
      timer = setTimeout(() => {
        entered = true;
        mockTimerEntered();
        void mockTimerGate.then(() => onFire(new Date())).then(resolve, reject);
      }, 0);
    });
    return { dispose: () => { clearTimeout(timer); if (!entered) resolveDisposed(); }, nextRun: () => undefined };
  },
}));

// Each committed schedule re-checks fresh workload authority before every
// durable write, and on Windows every check starts native permission checks:
// 37-49 s per case on a busy PC on its own, and up to twice that beside
// another worker. The limit leaves room for both.
const SCHEDULER_CASE_MS = 240_000;
// Cancel early enough that retirement and cleanup still finish in time.
const SCHEDULER_CLEANUP_MS = 20_000;

describe('committed schedule outlives its real request token', () => {
let consent!: ApprovedBundledFlujo;
const priorDek = global.__flujo_server_dek;
const priorSessions = global.__flujo_encryption_sessions;
beforeAll(async () => {
  global.__flujo_server_dek = undefined;
  global.__flujo_encryption_sessions = undefined;
  const startedAt = performance.now();
  consent = await installApprovedBundledFlujo({
    prefix: 'flujo-workload-control-',
    env: { FLUJO_ENCRYPTION_SECRET_FILE: undefined },
    beforeProvision: () => unlockPrivateFixtureInCurrentWorkspace(),
    timed: async (stage, operation) => {
      console.info('[workload-scheduler]', 'setup', stage, 'start', Math.round(performance.now() - startedAt));
      try { return await operation(); } finally { console.info('[workload-scheduler]', 'setup', stage, 'settled', Math.round(performance.now() - startedAt)); }
    },
  });
}, APPROVED_BUNDLED_FLUJO_SETUP_MS);
afterAll(async () => {
  try { await consent?.remove(); } finally {
    global.__flujo_server_dek = priorDek;
    global.__flujo_encryption_sessions = priorSessions;
  }
});

test.each(['unchanged', 'disabled', 'replaced', 'state-publication-disabled', 'retired-during-state-guard'] as const)('honors durable %s admission', async mode => {
  mockRunFlow.mockClear();
  const startedAt = performance.now();
  const timed = async <T,>(stage: string, operation: () => Promise<T>): Promise<T> => {
    console.info('[workload-scheduler]', mode, stage, 'start', Math.round(performance.now() - startedAt));
    try { return await operation(); } finally {
      console.info('[workload-scheduler]', mode, stage, 'settled', Math.round(performance.now() - startedAt));
    }
  };
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(new Error('Workload scheduler fixture cancellation deadline.')), SCHEDULER_CASE_MS - SCHEDULER_CLEANUP_MS);
  mockTimerCompleted = undefined;
  mockTimerGate = new Promise(resolve => { mockReleaseTimer = resolve; });
  mockTimerObserved = new Promise(resolve => { mockTimerEntered = resolve; });
  const approved = { config: consent.approved };
  let scheduler: SchedulerService | undefined;
  let executionId = '';
  let primaryError: unknown;
  let failed = false;
  let transport: { start(): Promise<void>; close(): Promise<void> } | undefined;
  try {
    const capsule = prepareBundledFlujoWorkload(approved.config)!;
    const environment = getPendingWorkloadEnvironment(approved.config, capsule);
    const token = environment.FLUJO_MCP_WORKLOAD_TOKEN;
    const request = () => new Request('http://127.0.0.1:4200/api/mcp/flujo/tools', { signal: cancellation.signal, headers: {
      host: '127.0.0.1:4200', 'x-flujo-workspace': getCurrentWorkspace(), authorization: `Bearer ${token}`,
    } });
    expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
    const start = jest.fn(async () => undefined), close = jest.fn(async () => undefined);
    transport = { start, close };
    await attachTrustedHost(transport, approved.config, undefined, capsule);
    await timed('start', () => transport!.start());
    expect(start).toHaveBeenCalledTimes(1);
    expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('authorized');
    scheduler = new SchedulerService();
    const admittedScheduler = scheduler;
    const admittedRequest = request();
    const admitted = await resolveBundledFlujoWorkloadRequest(admittedRequest);
    expect(admitted.kind).toBe('authorized');
    if (admitted.kind !== 'authorized') throw new Error('Genuine capability not admitted');
    await timed('create', () => withBundledFlujoWorkloadAuthorization(admitted.authorization, admittedRequest, async () => {
      expect(() => new SchedulerService()).toThrow();
      const created = await admittedScheduler.create({ name: 'fixture', enabled: true, flowId: 'fixture-flow',
        prompt: '', trigger: { type: 'schedule', cron: '0 0 1 1 *' } });
      expect(created.error).toBeUndefined();
      expect(created.execution).toBeDefined();
      executionId = created.execution!.id;
    }));
    await Promise.race([mockTimerObserved, mockTimerCompleted!.then(() => { throw new Error('Schedule completed before timer observation.'); })]);
    if (mode === 'disabled') await scheduler.update(executionId, { enabled: false });
    if (mode === 'state-publication-disabled') {
      const previous = await loadExecutionState(executionId);
      const realOpen = fs.promises.open.bind(fs.promises);
      let releaseOpen!: () => void;
      let enteredOpen!: () => void;
      const heldOpen = new Promise<void>(resolve => { releaseOpen = resolve; });
      const observedOpen = new Promise<void>(resolve => { enteredOpen = resolve; });
      const open = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (String(args[0]).includes(`planned-execution-state${path.sep}${executionId}.json.tmp.`)) {
          enteredOpen();
          await heldOpen;
        }
        return handle;
      });
      const refusal = new Error('durable schedule disabled before state publication');
      const publication = saveExecutionState(executionId, { ...previous, pendingFailures: 42 }, async () => {
        if (!(await admittedScheduler.get(executionId))?.enabled) throw refusal;
      });
      // Observe both outcomes immediately; a refused write never escapes as an unhandled rejection.
      const completedPublication = publication.then(() => undefined, () => undefined);
      try {
        await Promise.race([observedOpen, publication.then(() => { throw new Error('State publication completed before open observation.'); })]);
        await admittedScheduler.update(executionId, { enabled: false });
      } finally {
        releaseOpen();
        await completedPublication;
        open.mockRestore();
      }
      await expect(publication).rejects.toBe(refusal);
      expect(await loadExecutionState(executionId)).toEqual(previous);
    }

    if (mode === 'replaced') {
      const file = await loadItem<PlannedExecutionsFile>(StorageKey.PLANNED_EXECUTIONS, { version: 1, paused: false, executions: [] });
      file.executions = file.executions.map(execution => execution.id === executionId
        ? { ...execution, generationId: randomUUID() } : execution);
      await saveItem(StorageKey.PLANNED_EXECUTIONS, file);
    }
    if (mode === 'retired-during-state-guard') {
      const previous = await loadExecutionState(executionId);
      let releaseGuard!: () => void;
      let enteredGuard!: () => void;
      const heldGuard = new Promise<void>(resolve => { releaseGuard = resolve; });
      const observedGuard = new Promise<void>(resolve => { enteredGuard = resolve; });
      const publication = withBundledFlujoWorkloadAuthorization(admitted.authorization, admittedRequest, () =>
        saveExecutionState(executionId, { ...previous, pendingFailures: 43 }, async () => {
          enteredGuard();
          await heldGuard;
        }));
      const completedPublication = publication.then(() => undefined, () => undefined);
      try {
        await Promise.race([observedGuard, publication.then(() => { throw new Error('State publication completed before guard observation.'); })]);
        await transport.close();
        transport = undefined;
      } finally {
        releaseGuard();
        await completedPublication;
      }
      await expect(publication).rejects.toBeInstanceOf(BundledFlujoWorkloadError);
      expect(await loadExecutionState(executionId)).toEqual(previous);
    }
    const ledger = process.env.FLUJO_MCP_TRUSTED_HOST_FILE!;
    const namespace = createHash('sha256').update(path.resolve(ledger)).digest('hex').slice(0, 24);
    const workloadDirectory = path.join(path.dirname(ledger), `.flujo-workloads-${namespace}`);
    await transport?.close(); transport = undefined;
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(workloadDirectory)).toEqual([]);
    expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
    mockReleaseTimer();
    await mockTimerCompleted;
    expect(mockRunFlow).toHaveBeenCalledTimes(mode === 'unchanged' || mode === 'retired-during-state-guard' ? 1 : 0);
    await scheduler.update(executionId, { enabled: false });
  } catch (error) {
    failed = true;
    primaryError = error;
    throw error;
  } finally {
    clearTimeout(deadline);
    cancellation.abort(new Error('Workload scheduler fixture cleanup.'));
    const cleanupErrors: unknown[] = [];
    const attempt = async (cleanup: () => void | Promise<unknown>) => {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    };
    mockReleaseTimer();
    await attempt(() => mockTimerCompleted);
    await attempt(async () => {
      if (scheduler && executionId) await scheduler.update(executionId, { enabled: false });
    });
    await attempt(async () => {
      const { flushStatisticsEvents } = await import('@/backend/services/statistics');
      await flushStatisticsEvents();
    });
    await attempt(() => transport?.close());
    if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'Workload scheduler fixture cleanup failed');
    console.info('[workload-scheduler]', mode, 'cleanup', 'settled', Math.round(performance.now() - startedAt));
  }
}, SCHEDULER_CASE_MS);
});
