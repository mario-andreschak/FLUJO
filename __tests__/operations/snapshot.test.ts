import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundedJsonReader, ObservationReadError } from '@/backend/services/operations/boundedRead';
import { collectOperationsSnapshot, getObservationProcessId, type OperationsSources } from '@/backend/services/operations/snapshot';
import type { McpRuntimeRecord } from '@/backend/services/mcp/lifecycleCoordinator';
import * as plainReader from '@/utils/readPlainFile';
import snapshotTransfer from '@/shared/snapshotTransfer.json';

// Preserve the real reader behind mutable exports for the two race injections.
// Next's SWC named exports are otherwise non-configurable getters.
jest.mock('@/utils/readPlainFile', () => ({
  __esModule: true,
  ...jest.requireActual<typeof import('@/utils/readPlainFile')>('@/utils/readPlainFile'),
}));

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-operations-read-')); await fs.mkdir(path.join(root, 'db')); });
afterEach(async () => {
  jest.restoreAllMocks();
  const resolved = path.resolve(root);
  expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(resolved)).toMatch(/^flujo-operations-read-/);
  await fs.rm(resolved, { recursive: true, force: true });
});

function source(overrides: Partial<OperationsSources> = {}): OperationsSources {
  return { observationProcessId: '11111111-1111-4111-8111-111111111111', workspace: 'default-workspace', compatibility: { ...snapshotTransfer, applicationVersion: 'fixture', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1, workerSnapshotSourceVersion: 1 },
    worker: { mode: 'local', state: 'not-started' }, actor: { kind: 'owner', ownerId: 'owner-a', credentialId: 'grant-a' },
    read: boundedJsonReader(root), scheduler: plans => ({ workspace: 'default-workspace', started: true, pausedAtLastReconcile: false, armedTriggers: 0,
      runningRuns: 0, overlapQueued: 0, maxOverlapDepth: 0, exclusiveWaiting: 0, blockedByExclusive: 0, queueCap: 50,
      ownedWorkerRunIds: new Set(), statuses: plans.map(plan => ({ id: plan.id, status: { armed: false, running: false } })) }),
    workerRecovery: async () => undefined, active: [], mcp: [], memory: { rss: 100, heapUsed: 50, heapTotal: 80 }, ...overrides };
}
const plan = (id = 'plan-a') => ({ id, generationId: 'generation-a', enabled: true, flowId: 'flow-a',
  trigger: { type: 'schedule' }, prompt: 'SECRET_PROMPT', apiKey: 'SECRET_PLAN_KEY' });
async function plans(rows = [plan()]) { await fs.writeFile(path.join(root, 'db/planned_executions.json'), JSON.stringify({ version: 1, paused: false, executions: rows })); }

it('retains uncertainty and strips prompts, arguments, commands, raw errors and credential material', async () => {
  await plans(); await fs.mkdir(path.join(root, 'db/planned-execution-runs'));
  await fs.writeFile(path.join(root, 'db/planned-execution-runs/plan-a.json'), JSON.stringify([{ runId: 'run-a', status: 'error',
    outputText: 'SECRET_OUTPUT', error: 'SECRET_ERROR http 429', command: 'SECRET_COMMAND' }]));
  await fs.writeFile(path.join(root, 'db/pending_approvals.json'), JSON.stringify({ 'approval-a': {
    approvalId: 'approval-a', conversationId: 'conversation-a', plannedExecutionId: 'plan-a', runId: 'run-a',
    pendingToolCalls: [{ name: 'SECRET_TOOL', arguments: 'SECRET_ARGS' }], flowName: 'SECRET_NAME' } }));
  const inspect = jest.fn(async () => ({ eligible: false, reason: 'unresolved-admission' as const, state: 'rejected' as const,
    definitionSha256: 'a'.repeat(64), pending: { runId: 'run-a', occurrenceAt: new Date().toISOString() } }));
  const result = await collectOperationsSnapshot(source({ workerRecovery: inspect }));
  expect(JSON.stringify(result)).not.toContain('SECRET_');
  expect(result.schedules[0]).toMatchObject({ armed: false, indexedLastRun: { status: 'error' }, errorHint: 'rate-limit', recovery: { pendingRunId: 'run-a' } });
  expect(result.alerts.map(alert => alert.code)).toContain('unresolved-worker-admission');
  expect(result.scope.approvalAndHistory).toBe('unverified-durable-index');
  expect(await fs.readdir(path.join(root, 'db'))).toEqual(expect.arrayContaining(['planned_executions.json', 'pending_approvals.json']));
});

it('reports invalid/corrupt inputs as unavailable and creates no repair files', async () => {
  const target = path.join(root, 'db/planned_executions.json'); await fs.writeFile(target, '{broken SECRET_PATH');
  const result = await collectOperationsSnapshot(source());
  expect(result.complete).toBe(false);
  expect(result.scheduler.pausedInStoredConfig).toBeNull();
  expect(result.probes).toContainEqual({ component: 'planned-executions', state: 'unavailable', reason: 'invalid-json' });
  expect(await fs.readFile(target, 'utf8')).toBe('{broken SECRET_PATH');
  expect(await fs.readdir(path.join(root, 'db'))).toEqual(['planned_executions.json']);
  await fs.writeFile(target, 'false');
  expect((await collectOperationsSnapshot(source())).complete).toBe(false);
});

it('rejects over-budget and hardlinked input without reading outside the selected root', async () => {
  const target = path.join(root, 'db/sample.json'); await fs.writeFile(target, JSON.stringify({ value: 'x'.repeat(50) }));
  await expect(boundedJsonReader(root, 30, 30)('db/sample.json')).rejects.toMatchObject({ code: 'budget-exceeded' });
  await expect(boundedJsonReader(root)('../outside.json')).rejects.toMatchObject({ code: 'unsafe-path' });
  await fs.link(target, path.join(root, 'db/alias.json'));
  await expect(boundedJsonReader(root)('db/sample.json')).rejects.toMatchObject({ code: 'unsafe-path' });
});

it('shares a finite byte budget across reads', async () => {
  await fs.writeFile(path.join(root, 'db/one.json'), '{"one":1}');
  await fs.writeFile(path.join(root, 'db/two.json'), '{"two":2}');
  const read = boundedJsonReader(root, 12, 12);
  expect(await read('db/one.json')).toEqual({ one: 1 });
  await expect(read('db/two.json')).rejects.toMatchObject({ code: 'budget-exceeded' });
});

it('exposes only matching runtime/generation exit observations; cold or missing cache is not exit proof', async () => {
  const runtime = { runtimeId: 'runtime-a', generation: 2, workspace: 'default-workspace', serverName: 'stdio-a', state: 'cold',
    leases: 0, pins: new Set(), command: 'SECRET_COMMAND', shutdownReceipt: { schemaVersion: 1, runtimeId: 'runtime-a', generation: 1,
      workspace: 'default-workspace', serverName: 'stdio-a', processOwnership: 'owned', exitOutcome: 'observed_exit', forced: true,
      errorClassification: 'none', observedAt: new Date().toISOString(), durationMs: 10 } } as unknown as McpRuntimeRecord;
  let result = await collectOperationsSnapshot(source({ mcp: [runtime] }));
  expect(result.processes[0].shutdown.exitOutcome).toBe('unknown');
  expect(result.alerts.map(alert => alert.code)).toContain('shutdown-exit-unobserved');
  runtime.shutdownReceipt!.generation = 2;
  result = await collectOperationsSnapshot(source({ mcp: [runtime] }));
  expect(result.processes[0].shutdown).toMatchObject({ processOwnership: 'owned', exitOutcome: 'observed_exit', generation: 2 });
  expect(JSON.stringify(result)).not.toContain('SECRET_COMMAND');
});

it('keeps output rows bounded while declaring incomplete observation instead of hiding live ownership', async () => {
  await plans(Array.from({ length: 201 }, (_, index) => plan(`plan-${index}`)));
  const result = await collectOperationsSnapshot(source());
  expect(result.schedules).toHaveLength(200); expect(result.truncated).toBe(true); expect(result.complete).toBe(false);
  expect(result.alerts.map(alert => alert.code)).toContain('diagnostic-row-budget-reached');
  const original = JSON.parse(await fs.readFile(path.join(root, 'db/planned_executions.json'), 'utf8'));
  expect(original.executions).toHaveLength(201);
});

it('marks read errors and invalid observation budgets honestly', async () => {
  const result = await collectOperationsSnapshot(source({ read: async () => { throw new ObservationReadError('unavailable'); }, rssBudgetBytes: -1 }));
  expect(result.complete).toBe(false); expect(result.memory).not.toHaveProperty('configuredRssBudgetBytes');
  expect(result.probes).toContainEqual({ component: 'rss-observation-budget', state: 'unavailable', reason: 'invalid-config' });
});

it('keeps process correlation stable across workspace selections and memory process-wide', async () => {
  const processId = getObservationProcessId();
  expect(processId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(getObservationProcessId()).toBe(processId);
  const result = await collectOperationsSnapshot(source({ observationProcessId: processId }));
  expect(result.observationProcessId).toBe(processId);
  expect(result.scope).toMatchObject({ memory: 'this-process-all-workspaces', mcpRecords: 'this-process-and-workspace' });
  const other = source({ observationProcessId: processId, workspace: 'other-workspace' });
  const scheduler = other.scheduler;
  other.scheduler = rows => ({ ...scheduler(rows), workspace: 'other-workspace' });
  expect((await collectOperationsSnapshot(other)).observationProcessId).toBe(processId);
});

it('filters foreign MCP records and refuses a scheduler from another workspace', async () => {
  const foreign = { workspace: 'other-workspace', runtimeId: 'foreign-runtime', generation: 2, state: 'cold',
    leases: 0, pins: new Set() } as unknown as McpRuntimeRecord;
  const result = await collectOperationsSnapshot(source({ mcp: [foreign] }));
  expect(result.processes).toEqual([]);
  expect(result.alerts.some(alert => alert.code === 'shutdown-exit-unobserved')).toBe(false);
  const wrong = source();
  const scheduler = wrong.scheduler;
  wrong.scheduler = rows => ({ ...scheduler(rows), workspace: 'other-workspace' });
  await expect(collectOperationsSnapshot(wrong)).rejects.toThrow('Observation workspace mismatch');
});

it('passes exact bigint admission to the shared reader and refuses a changed file', async () => {
  const target = path.join(root, 'db/sample.json');
  await fs.writeFile(target, '{"one":1}');
  const actual = plainReader.readPlainFile;
  jest.spyOn(plainReader, 'readPlainFile').mockImplementationOnce(async (file, options) => {
    expect(typeof options?.expected?.ino).toBe('bigint');
    expect(typeof options?.expected?.mtimeNs).toBe('bigint');
    await fs.writeFile(file, '{"changed":2}');
    return actual(file, options);
  });
  await expect(boundedJsonReader(root)('db/sample.json')).rejects.toMatchObject({ code: 'unsafe-path' });
});

it('binds parent identity across opening and reading; a replaced directory is not adopted', async () => {
  await fs.writeFile(path.join(root, 'db/sample.json'), '{"one":1}');
  const actual = plainReader.readPlainFile;
  jest.spyOn(plainReader, 'readPlainFile').mockImplementationOnce(async (file, options) => {
    await fs.rename(path.join(root, 'db'), path.join(root, 'retired-db'));
    await fs.mkdir(path.join(root, 'db'));
    await fs.writeFile(file, '{"one":1}');
    // Independently exercise the caller's parent fence, even for equal bytes.
    await options?.verifyPath?.();
    return actual(file, options);
  });
  await expect(boundedJsonReader(root)('db/sample.json')).rejects.toMatchObject({ code: 'unsafe-path' });
});

it('charges failed parsing against the shared read budget', async () => {
  await fs.writeFile(path.join(root, 'db/sample.json'), '{');
  const read = boundedJsonReader(root, 2, 2);
  await expect(read('db/sample.json')).rejects.toMatchObject({ code: 'invalid-json' });
  await expect(read('db/sample.json')).rejects.toMatchObject({ code: 'invalid-json' });
  await expect(read('db/sample.json')).rejects.toMatchObject({ code: 'budget-exceeded' });
});
