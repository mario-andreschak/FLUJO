import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchedulerService } from '@/backend/services/scheduler';
import { setWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';
import { workerRecoveryDefinitionSha256, claimWorkerOccurrence, inspectWorkerRecovery, recordWorkerTerminalObservation } from '@/backend/services/scheduler/workerLocalRecovery';
import * as recoveryFs from '@/backend/services/workspace/backupRestoreFs';
import { loadRunRecords } from '@/backend/services/scheduler/runHistory';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { getDataDir } from '@/utils/paths';
import { collectOperationsSnapshot } from '@/backend/services/operations/snapshot';
import { boundedJsonReader } from '@/backend/services/operations/boundedRead';
import type { PlannedExecution, RunRecord } from '@/shared/types/plannedExecution';

const callbacks: Array<{ fire: (occurrence: Date) => Promise<void>; dispose: jest.Mock }> = [];
const runFlowMock = jest.fn();
jest.mock('@/backend/services/scheduler/triggers/schedule', () => ({
  ...jest.requireActual('@/backend/services/scheduler/triggers/schedule'),
  armSchedule: jest.fn((_config: unknown, fire: (occurrence: Date) => Promise<void>) => {
    const dispose = jest.fn(); callbacks.push({ fire, dispose });
    return { dispose, nextRun: () => '2099-01-01T00:00:00.000Z' };
  }),
}));
jest.mock('@/backend/execution/flow/runFlow', () => ({ runFlow: (...args: unknown[]) => runFlowMock(...args) }));
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: async () => null } }));
jest.mock('@/backend/services/workspace/backupRestoreFs', () => {
  const actual = jest.requireActual('@/backend/services/workspace/backupRestoreFs');
  return { ...actual, atomicWriteWithoutLinks: jest.fn(actual.atomicWriteWithoutLinks) };
});

const keys = ['FLUJO_WORKER_MODE', 'FLUJO_WORKER_RECOVERY_ID', 'FLUJO_WORKER_RECOVERY_EPOCH',
  'FLUJO_SNAPSHOT_CONTROL_TOKEN', 'FLUJO_WORKER_SNAPSHOT_SHA256'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const input = () => ({ id: randomUUID(), name: 'Local watch', enabled: true, startRestriction: 'singleton' as const,
  flowId: 'fixture-flow', prompt: 'Disposable fixture', overlapStrategy: 'skip' as const,
  trigger: { type: 'schedule' as const, cron: '* * * * *', catchUp: true } });
let scheduler: SchedulerService;
const instances: SchedulerService[] = [];
async function enroll(plan: PlannedExecution, enabled = true) {
  await scheduler.setWorkerLocalRecovery(plan.id, { enabled, expectedGenerationId: plan.generationId!,
    expectedDefinitionSha256: workerRecoveryDefinitionSha256(plan) });
}
const nextOccurrence = () => new Date(Date.now() + 60_000);

beforeEach(async () => {
  Object.assign(process.env, { FLUJO_WORKER_MODE: '1', FLUJO_WORKER_RECOVERY_ID: 'scheduler-worker-a',
    FLUJO_WORKER_RECOVERY_EPOCH: '1', FLUJO_SNAPSHOT_CONTROL_TOKEN: 'test-only-scheduler-control',
    FLUJO_WORKER_SNAPSHOT_SHA256: 'a'.repeat(64) });
  setWorkerBootstrapStatus({ state: 'ready', workspace: getCurrentWorkspace() });
  await saveItem(StorageKey.PLANNED_EXECUTIONS, { version: 1, paused: false, executions: [] });
  callbacks.length = 0;
  jest.mocked(recoveryFs.atomicWriteWithoutLinks).mockReset().mockImplementation(
    jest.requireActual('@/backend/services/workspace/backupRestoreFs').atomicWriteWithoutLinks);
  runFlowMock.mockReset().mockResolvedValue({ status: 'completed', outputText: 'fixture',
    messages: [], sharedState: {}, conversationId: 'fixture' });
  scheduler = new SchedulerService(); instances.push(scheduler);
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const instance of instances.splice(0)) await instance.setPaused(true);
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  global.__flujo_worker_bootstrap_status = undefined;
});

it('arms only explicitly enrolled local plans while copied siblings stay inert across reconcile/update/start', async () => {
  const local = (await scheduler.create(input())).execution!;
  const copied = { ...input(), generationId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await saveItem(StorageKey.PLANNED_EXECUTIONS, { version: 1, paused: false, executions: [local, copied] });
  await scheduler.start();
  expect(callbacks).toHaveLength(0);
  await enroll(local);
  expect(callbacks).toHaveLength(1);
  await scheduler.update(copied.id, { enabled: true });
  await scheduler.reconcile(); await scheduler.start();
  const entries = await scheduler.list();
  expect(entries.find(entry => entry.execution.id === local.id)?.status).toMatchObject({ armed: true, workerRecovery: { state: 'armed' } });
  expect(entries.find(entry => entry.execution.id === copied.id)?.status).toMatchObject({ armed: false, workerRecovery: { reason: 'no-local-provenance' } });
  expect(callbacks).toHaveLength(1);
  expect(runFlowMock).not.toHaveBeenCalled();
});

it('records actual successful effects separately from arming and deduplicates a repeated occurrence', async () => {
  const plan = (await scheduler.create(input())).execution!;
  await enroll(plan);
  expect(runFlowMock).not.toHaveBeenCalled();
  const occurrence = nextOccurrence();
  await callbacks[0].fire(occurrence);
  await callbacks[0].fire(occurrence);
  expect(runFlowMock).toHaveBeenCalledTimes(1);
  const history = await loadRunRecords(plan.id);
  expect(history.filter(record => record.status === 'completed')).toHaveLength(1);
  expect(history[0].executionGenerationId).toBe(plan.generationId);
});

it('recovers one local generation in a fresh scheduler instance and keeps a sibling copied row suppressed', async () => {
  const plan = (await scheduler.create(input())).execution!;
  await enroll(plan);
  await scheduler.setPaused(true); // dispose the first fixture instance's timer
  const file = await loadItem<{ version: 1; paused: boolean; executions: PlannedExecution[] }>(StorageKey.PLANNED_EXECUTIONS, { version: 1, paused: false, executions: [] });
  await saveItem(StorageKey.PLANNED_EXECUTIONS, { ...file, paused: false });
  const fresh = new SchedulerService(); instances.push(fresh);
  await fresh.start(); await fresh.start(); await fresh.reconcile();
  expect(fresh.getStatus(plan).armed).toBe(true);
  expect(callbacks).toHaveLength(2);
  await callbacks[1].fire(nextOccurrence());
  expect(runFlowMock).toHaveBeenCalledTimes(1);
});

it('rejects copied terminal history and reconciles a privately observed completed result without relaunch', async () => {
  const plan = (await scheduler.create(input())).execution!;
  await enroll(plan);
  const occurrenceAt = nextOccurrence().toISOString();
  expect(await claimWorkerOccurrence(plan, occurrenceAt, 'interrupted-run')).toBe('eligible');
  const fresh = new SchedulerService(); instances.push(fresh);
  await fresh.start();
  expect((await fresh.list())[0].status).toMatchObject({ armed: false, workerRecovery: { reason: 'unresolved-admission' } });
  expect(runFlowMock).not.toHaveBeenCalled();
  const completed: RunRecord = { runId: 'interrupted-run', executionGenerationId: plan.generationId,
    conversationId: 'owned-result', firedAt: occurrenceAt, finishedAt: occurrenceAt,
    status: 'completed', triggerSummary: 'Schedule' };
  await saveItem(`planned-execution-runs/${plan.id}` as StorageKey, [completed]);
  await fresh.reconcile();
  expect(fresh.getStatus(plan).armed).toBe(false);
  // Simulate the trusted live terminal chokepoint crashing before clearing its receipt.
  await recordWorkerTerminalObservation(plan, completed);
  await fresh.reconcile();
  expect(fresh.getStatus(plan).armed).toBe(true);
  expect(runFlowMock).not.toHaveBeenCalled();
});

it('observes signed terminal uncertainty without reconciling it, writing storage or arming another timer', async () => {
  const plan = (await scheduler.create(input())).execution!;
  await enroll(plan);
  const occurrenceAt = nextOccurrence().toISOString();
  expect(await claimWorkerOccurrence(plan, occurrenceAt, 'diagnostic-pending-run')).toBe('eligible');
  await recordWorkerTerminalObservation(plan, { runId: 'diagnostic-pending-run', executionGenerationId: plan.generationId,
    firedAt: occurrenceAt, finishedAt: occurrenceAt, status: 'completed', triggerSummary: 'Fixture' });
  const controlFile = path.join(getDataDir(), '.worker-local-recovery', getCurrentWorkspace(),
    `${createHash('sha256').update(`${getCurrentWorkspace()}\0${plan.id}`).digest('hex')}.json`);
  const before = await fs.readFile(controlFile);
  const writes = jest.mocked(recoveryFs.atomicWriteWithoutLinks).mock.calls.length;
  const timers = callbacks.length;
  const result = await collectOperationsSnapshot({ workspace: getCurrentWorkspace(),
    compatibility: { applicationVersion: '3.46.2', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 },
    worker: { mode: 'worker', state: 'ready' }, actor: { kind: 'worker-control' },
    read: boundedJsonReader(getWorkspaceDataDir()), scheduler: rows => scheduler.inspectOperations(rows),
    workerRecovery: inspectWorkerRecovery, active: [], mcp: [], memory: { rss: 100, heapUsed: 50, heapTotal: 80 } });
  expect(result.schedules.find(row => row.id === plan.id)).toMatchObject({ armed: false,
    recovery: { reason: 'unresolved-admission', pendingRunId: 'diagnostic-pending-run' } });
  expect(await fs.readFile(controlFile)).toEqual(before);
  expect(jest.mocked(recoveryFs.atomicWriteWithoutLinks)).toHaveBeenCalledTimes(writes);
  expect(callbacks).toHaveLength(timers);
  expect(runFlowMock).not.toHaveBeenCalled();
});

it('disarms after revocation and refuses unadmitted automatic firing of copied rows', async () => {
  const plan = (await scheduler.create(input())).execution!;
  await enroll(plan); await enroll(plan, false);
  expect(scheduler.getStatus(plan).armed).toBe(false);
  expect(callbacks[0].dispose).toHaveBeenCalled();
  await callbacks[0].fire(nextOccurrence());
  const denied = await scheduler.fire(plan, { kind: 'schedule', summary: 'forged automatic admission' });
  expect(denied.status).toBe('skipped');
  expect(runFlowMock).not.toHaveBeenCalled();
});

it('keeps global pause and definition changes authoritative over opted-in state', async () => {
  const plan = (await scheduler.create(input())).execution!;
  await scheduler.setPaused(true); await enroll(plan);
  expect(scheduler.getStatus(plan).armed).toBe(false);
  await scheduler.setPaused(false);
  expect(scheduler.getStatus(plan).armed).toBe(true);
  await scheduler.update(plan.id, { prompt: 'Changed after enrollment' });
  expect(scheduler.getStatus(plan)).toMatchObject({ armed: false, workerRecovery: { reason: 'definition-changed' } });
});

it('uses the existing bounded one-occurrence catch-up policy after a controlled same-worker restart', async () => {
  const plan = (await scheduler.create(input())).execution!;
  await enroll(plan); await scheduler.setPaused(true);
  const file = await loadItem<{ version: 1; paused: boolean; executions: PlannedExecution[] }>(StorageKey.PLANNED_EXECUTIONS, { version: 1, paused: false, executions: [] });
  await saveItem(StorageKey.PLANNED_EXECUTIONS, { ...file, paused: false });
  await saveItem(`planned-execution-state/${plan.id}` as StorageKey, { lastScheduledFireAt: plan.createdAt });
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(plan.createdAt) + 600_000);
  const fresh = new SchedulerService(); instances.push(fresh);
  await fresh.start();
  // Startup installs timers before the fire's asynchronous terminal persistence.
  for (let count = 0; count < 100 && (await loadRunRecords(plan.id)).length === 0; count++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(runFlowMock).toHaveBeenCalledTimes(1);
  expect((await loadRunRecords(plan.id))[0]).toMatchObject({ status: 'completed', triggerSummary: expect.stringContaining('missed while') });
  await fresh.reconcile(); await fresh.start();
  expect(runFlowMock).toHaveBeenCalledTimes(1);
});

it('does not enter the engine when disk-full prevents its write-ahead admission', async () => {
  const plan = (await scheduler.create(input())).execution!; await enroll(plan);
  jest.mocked(recoveryFs.atomicWriteWithoutLinks).mockRejectedValueOnce(Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }));
  await callbacks[0].fire(nextOccurrence());
  expect(runFlowMock).not.toHaveBeenCalled();
  expect(scheduler.getStatus(plan).lastTriggerError).toContain('fixture disk full');
  expect((await inspectWorkerRecovery(plan, false))?.pending).toBeUndefined();
});

it('retains admission when clearing a signed terminal observation fails, then observes without replay', async () => {
  const plan = (await scheduler.create(input())).execution!; await enroll(plan);
  const actual = jest.requireActual('@/backend/services/workspace/backupRestoreFs').atomicWriteWithoutLinks;
  const write = jest.mocked(recoveryFs.atomicWriteWithoutLinks).mockImplementation(async (root, target, content, options) => {
    if (!JSON.parse(content.toString()).pending) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    return actual(root, target, content, options);
  });
  await callbacks[0].fire(nextOccurrence());
  expect(runFlowMock).toHaveBeenCalledTimes(1);
  expect(await inspectWorkerRecovery(plan, false)).toMatchObject({ eligible: false, reason: 'unresolved-admission' });
  expect((await loadRunRecords(plan.id))[0].status).toBe('completed');
  write.mockImplementation(actual);
  await scheduler.reconcile();
  expect((await inspectWorkerRecovery(plan, false))?.pending).toBeUndefined();
  expect(runFlowMock).toHaveBeenCalledTimes(1);
});

it('keeps uncertainty when disk-full prevents the private terminal observation itself', async () => {
  const plan = (await scheduler.create(input())).execution!; await enroll(plan);
  const actual = jest.requireActual('@/backend/services/workspace/backupRestoreFs').atomicWriteWithoutLinks;
  const write = jest.mocked(recoveryFs.atomicWriteWithoutLinks).mockImplementation(async (root, target, content, options) => {
    if (JSON.parse(content.toString()).terminal) throw Object.assign(new Error('fixture terminal disk full'), { code: 'ENOSPC' });
    return actual(root, target, content, options);
  });
  await callbacks[0].fire(nextOccurrence());
  write.mockImplementation(actual);
  await scheduler.reconcile();
  expect(runFlowMock).toHaveBeenCalledTimes(1);
  expect((await inspectWorkerRecovery(plan, false))).toMatchObject({ reason: 'unresolved-admission', eligible: false });
  expect((await loadRunRecords(plan.id)).some(record => record.status === 'completed')).toBe(false);
});

it('preserves singleton/skip while an owned admitted run is still executing', async () => {
  const plan = (await scheduler.create(input())).execution!; await enroll(plan);
  let release!: (result: unknown) => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  runFlowMock.mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const first = callbacks[0].fire(nextOccurrence());
  await reached;
  try {
    await callbacks[0].fire(new Date(Date.now() + 120_000));
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect((await loadRunRecords(plan.id))[0]).toMatchObject({ status: 'skipped', error: expect.stringContaining('unresolved-admission') });
  } finally { release({ status: 'completed', outputText: 'fixture', messages: [], sharedState: {}, conversationId: 'fixture' }); }
  await first;
  expect((await inspectWorkerRecovery(plan, false))?.pending).toBeUndefined();
});

it('keeps approval-paused work unresolved through restart instead of admitting another writer', async () => {
  const plan = (await scheduler.create(input())).execution!; await enroll(plan);
  const at = nextOccurrence().toISOString();
  await claimWorkerOccurrence(plan, at, 'approval-run');
  await saveItem(`planned-execution-runs/${plan.id}` as StorageKey, [{ runId: 'approval-run',
    executionGenerationId: plan.generationId, firedAt: at, finishedAt: at,
    status: 'needs_approval', conversationId: 'approval-conversation', triggerSummary: 'Schedule' }]);
  const fresh = new SchedulerService(); instances.push(fresh); await fresh.start();
  expect((await fresh.list())[0].status).toMatchObject({ armed: false, workerRecovery: { reason: 'unresolved-admission' } });
  expect(runFlowMock).not.toHaveBeenCalled();
});

it('honors revocation that arrives after admission while execution awaits config IO', async () => {
  const plan = (await scheduler.create(input())).execution!; await enroll(plan);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const actual = scheduler.get.bind(scheduler);
  jest.spyOn(scheduler, 'get').mockImplementationOnce(async id => {
    entered(); await held; return actual(id);
  });
  const completion = callbacks[0].fire(nextOccurrence());
  try { await reached; await enroll(plan, false); } finally { release(); }
  await completion;
  expect(runFlowMock).not.toHaveBeenCalled();
  expect((await loadRunRecords(plan.id))[0]).toMatchObject({ status: 'error', error: expect.stringContaining('fenced') });
  expect((await scheduler.list())[0].status).toMatchObject({ armed: false, workerRecovery: { reason: 'not-opted-in' } });
});
