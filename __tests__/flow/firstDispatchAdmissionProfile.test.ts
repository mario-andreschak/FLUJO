/** #757: bounded real storage, catalog, credential and SDK profiling. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { randomBytes } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import type { Flow } from '@/shared/types/flow';
import type { SharedState } from '@/backend/execution/flow/types';
import type { StorageKey } from '@/shared/types/storage';

interface Span { phase: string; conversationId?: string; start: number; admitted?: number; end: number }
const mockSpans: Span[] = [];
const mockContext = new AsyncLocalStorage<string>();
let mockMeasuring = false;
function mockBegin(phase: string): Span {
  const span = { phase, conversationId: mockContext.getStore(), start: performance.now(), end: 0 };
  if (mockMeasuring) mockSpans.push(span);
  return span;
}
async function mockMeasure<T>(phase: string, task: () => Promise<T>): Promise<T> {
  const span = mockBegin(phase);
  try { return await task(); } finally { span.end = performance.now(); }
}
// Wrappers time real calls and propagate their results/errors without substituting authority.
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => {
  const actual = jest.requireActual<typeof import('@/backend/services/enduringAgents/runtimeLock')>('@/backend/services/enduringAgents/runtimeLock');
  return { ...actual, withWorkspaceProcessMutation: async <T,>(task: () => Promise<T>) => {
    const span = mockBegin('writerAdmission');
    try { return await actual.withWorkspaceProcessMutation(async () => { span.admitted = performance.now(); return task(); }); }
    finally { span.end = performance.now(); }
  } };
});
jest.mock('@/backend/execution/flow/persistConversationState', () => {
  const actual = jest.requireActual<typeof import('@/backend/execution/flow/persistConversationState')>('@/backend/execution/flow/persistConversationState');
  return { ...actual, persistConversationState: (...args: Parameters<typeof actual.persistConversationState>) => mockMeasure('persistence', () => actual.persistConversationState(...args)) };
});
jest.mock('@/backend/execution/flow/recoveryCheckpoint', () => {
  const actual = jest.requireActual<typeof import('@/backend/execution/flow/recoveryCheckpoint')>('@/backend/execution/flow/recoveryCheckpoint');
  return { ...actual,
    commitRecoveryTransition: (...args: Parameters<typeof actual.commitRecoveryTransition>) => mockMeasure('recoveryTransition', () => actual.commitRecoveryTransition(...args)),
    commitRecoveryCheckpoint: (...args: Parameters<typeof actual.commitRecoveryCheckpoint>) => mockMeasure('recoveryCheckpoint', () => actual.commitRecoveryCheckpoint(...args)),
  };
});
jest.mock('@/backend/execution/flow/modelTurnArchive', () => {
  const actual = jest.requireActual<typeof import('@/backend/execution/flow/modelTurnArchive')>('@/backend/execution/flow/modelTurnArchive');
  return { ...actual, archiveModelDispatch: (...args: Parameters<typeof actual.archiveModelDispatch>) => mockMeasure('archiveDispatch', () => actual.archiveModelDispatch(...args)) };
});
// Suppress diagnostic chatter; durable execution events and all filesystem IO remain real.
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: () => {}, verbose: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { _setConversationLogDirForTests, flushConversationLog, readConversationLog } from '@/backend/execution/flow/conversationLog';
import { loadItem, saveCollectionItem } from '@/utils/storage/backend';
import { getArchiveWritePressure } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';
import { ensureWorkspaceDirs, getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import { withWorkspaceRecoveryCapture } from '@/backend/services/workspace/workspaceMutationGate';
import { modelService } from '@/backend/services/model';
import { getFlowRunAdmissionDiagnostics } from '@/backend/execution/flow/runAdmission';
import { getConversationPublicationDiagnostics } from '@/backend/execution/flow/conversationPublication';
import { getAllocationReservationSnapshot } from '@/backend/execution/flow/allocationReservations';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { flushStatisticsEvents } from '@/backend/services/statistics';

jest.setTimeout(90_000);
let server: Server;
let root: string;
let logRoot: string, previousLogRoot: string, temporaryParent: string;
let rootIdentity: BigIntStats;
let previousEnvironment: Record<string, string | undefined>;
let baseUrl = '';
const requests = new Map<string, Array<{ monotonic: number; epoch: number }>>();
const summaries: unknown[] = [];
const output = process.env.FLUJO_DISPATCH_PROFILE_OUTPUT;
const diagnosticOutput = process.env.FLUJO_DISPATCH_PROFILE_DIAGNOSTICS;
const label = process.env.FLUJO_DISPATCH_PROFILE_LABEL ?? 'local';
function assertFixtureStorage(): void {
  const relative = path.relative(root, getWorkspaceDataDir());
  expect(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)).toBe(true);
  expect(path.resolve(logRoot)).toBe(path.join(root, 'conversation-logs'));
}
function pressureSnapshot() {
  return { publication: getConversationPublicationDiagnostics(), run: getFlowRunAdmissionDiagnostics(),
    allocation: { ...getAllocationReservationSnapshot() }, memory: { ...process.memoryUsage(), heapLimit: getHeapStatistics().heap_size_limit } };
}
// Only bounded codes/statuses leave this fixture: never prompts, provider payloads,
// credentials, stack traces, or arbitrary exception messages.
function errorIdentity(error: unknown): { code?: string; status?: number } {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown; details?: { code?: unknown } };
  const code = candidate.details?.code ?? candidate.code;
  const status = candidate.statusCode ?? candidate.status;
  return { ...(typeof code === 'string' ? { code: code.slice(0, 96) } : {}),
    ...(typeof status === 'number' && Number.isFinite(status) ? { status } : {}) };
}
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0) * 1000) / 1000;
}
function stats(values: number[]) { return { count: values.length, sumMs: values.reduce((a, b) => a + b, 0), p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Math.max(0, ...values) }; }
function inspectorCall<T>(session: Session, method: string): Promise<T> {
  return new Promise((resolve, reject) => session.post(method, (error, result) => error ? reject(error) : resolve(result as T)));
}
beforeAll(async () => {
  previousEnvironment = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR',
    'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_WORKER_MODE', 'FLUJO_WORKER_SNAPSHOT_KEY']
    .map(key => [key, process.env[key]]));
  temporaryParent = await fs.realpath(os.tmpdir());
  root = await fs.mkdtemp(path.join(temporaryParent, 'flujo-dispatch-admission-'));
  rootIdentity = await fs.lstat(root, { bigint: true });
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  for (const key of ['FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKER_MODE', 'FLUJO_WORKER_SNAPSHOT_KEY']) delete process.env[key];
  logRoot = path.join(root, 'conversation-logs');
  await fs.mkdir(logRoot);
  previousLogRoot = _setConversationLogDirForTests(logRoot);
  assertFixtureStorage();
  const secretFile = path.join(root, 'operator-secret');
  await fs.writeFile(secretFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  const getModel = modelService.getModel.bind(modelService);
  jest.spyOn(modelService, 'getModel').mockImplementation(id => mockMeasure('modelCatalog', () => getModel(id)));
  const loadModels = modelService.loadModels.bind(modelService);
  jest.spyOn(modelService, 'loadModels').mockImplementation(() => mockMeasure('modelCatalogRead', () => loadModels()));
  const resolveKey = modelService.resolveAndDecryptApiKey;
  jest.spyOn(modelService, 'resolveAndDecryptApiKey').mockImplementation(key => mockMeasure('credentials', () => resolveKey(key)));
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = JSON.stringify(body.messages).match(/queue-\d+-\d+-\d+/)?.[0];
      if (!id) { response.writeHead(400); response.end('Missing local identity'); return; }
      requests.set(id, [...(requests.get(id) ?? []), { monotonic: performance.now(), epoch: Date.now() }]);
      const base = { id: 'local-response', created: 1, model: 'dispatch-profile' };
      const content = `answer ${id}`;
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }] }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  mockMeasuring = false; jest.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await flushStatisticsEvents();
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: 0, writers: 0, openBatches: 0, chains: 0, fences: 0 });
  FlowExecutor.conversationStates.clear(); FlowExecutor.clearFlowCache();
  if (output) { await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, `${label}-summary.json`), JSON.stringify(summaries, null, 2)); }
  const current = await fs.lstat(root, { bigint: true });
  const relative = path.relative(temporaryParent, path.resolve(root));
  if (relative !== path.basename(root) || !relative.startsWith('flujo-dispatch-admission-')
    || current.isSymbolicLink() || !current.isDirectory() || await fs.realpath(root) !== root
    || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || current.birthtimeNs !== rootIdentity.birthtimeNs) {
    throw new Error('Preserving replaced or unowned dispatch profile fixture');
  }
  _setConversationLogDirForTests(previousLogRoot);
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});
it.each([[1, 0], [16, 1], [16, 2]])('profiles real saved-model dispatch (concurrency=%i, repetition=%i)', async (count, repetition) => {
  await runWithWorkspace(`queue-profile-${count}-${repetition}`, async () => {
    assertFixtureStorage();
    requests.clear(); await ensureWorkspaceDirs();
    const saved = await modelService.addModel({ id: 'dispatch-model', name: 'dispatch-profile', displayName: 'Local dispatch profile', provider: 'openai', adapter: 'openai', ApiKey: 'local-loopback-marker', baseUrl });
    expect(saved.error).toBeUndefined(); expect(saved.success).toBe(true);
    const flow: Flow = { id: 'queue-saved-flow', name: 'queue-profile', nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'start', type: 'start', properties: {} } },
      { id: 'process', type: 'process', position: { x: 1, y: 0 }, data: { label: 'process', type: 'process', properties: { boundModel: 'dispatch-model' } } },
      { id: 'finish', type: 'finish', position: { x: 2, y: 0 }, data: { label: 'finish', type: 'finish', properties: {} } },
    ], edges: [
      { id: 'start-process', source: 'start', target: 'process', data: { edgeType: 'standard' } },
      { id: 'process-finish', source: 'process', target: 'finish', data: { edgeType: 'standard' } },
    ] };
    await saveCollectionItem('flows', flow.id, flow);
    mockSpans.length = 0; mockMeasuring = true;
    const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
    const inspector = output ? new Session() : undefined;
    if (inspector) { inspector.connect(); await inspectorCall(inspector, 'Profiler.enable'); await inspectorCall(inspector, 'Profiler.start'); }
    const started = performance.now();
    const ids = Array.from({ length: count }, (_, index) => `queue-${count}-${repetition}-${index}`);
    const liveDispatches = new Map<string, number>();
    const unsubscribeDispatches = executionEventBus.subscribeGlobal(({ event }) => {
      if (event.type === 'model:dispatch' && ids.includes(event.conversationId)) {
        liveDispatches.set(event.conversationId, (liveDispatches.get(event.conversationId) ?? 0) + 1);
      }
    });
    const initialPressure = pressureSnapshot();
    const peakPressure = pressureSnapshot();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Bounded local dispatch deadline')), 60_000);
    const peak = { bytes: 0, writers: 0, waiters: 0 };
    const sampler = setInterval(() => {
      const sample = pressureSnapshot();
      for (const group of ['publication', 'run', 'allocation', 'memory'] as const) {
        const current: Record<string, number> = sample[group], maximum: Record<string, number> = peakPressure[group];
        for (const key of Object.keys(current)) maximum[key] = Math.max(maximum[key], current[key]);
      }
      const pressure = getArchiveWritePressure();
      peak.bytes = Math.max(peak.bytes, pressure.bytes); peak.writers = Math.max(peak.writers, pressure.writers);
      peak.waiters = Math.max(peak.waiters, (globalThis as typeof globalThis & { __flujoArchiveWriteQueue?: unknown[] }).__flujoArchiveWriteQueue?.length ?? 0);
    }, 10);
    let submissions: PromiseSettledResult<Awaited<ReturnType<typeof runFlow>>>[];
    try {
      submissions = await Promise.allSettled(ids.map(conversationId => mockContext.run(conversationId, () => runFlow({ conversationId, flowId: flow.id, prompt: `Return exactly ${conversationId}. ${'filler '.repeat(500)}`, source: 'api', mode: 'conversation', abortSignal: controller.signal }))));
    } finally {
      clearTimeout(deadline); clearInterval(sampler); delay.disable(); mockMeasuring = false; unsubscribeDispatches();
      if (inspector) {
        const { profile } = await inspectorCall<{ profile: unknown }>(inspector, 'Profiler.stop'); inspector.disconnect();
        await fs.mkdir(output!, { recursive: true }); await fs.writeFile(path.join(output!, `${label}-${count}-${repetition}.cpuprofile`), JSON.stringify(profile));
      }
    }
    const completeMs = performance.now() - started;
    const settledPressure = pressureSnapshot();
    const outcomes = [];
    // The real reader has its own bounded concurrency. Read diagnostics serially
    // so observation cannot manufacture unrelated log-read admission failures.
    for (const [index, id] of ids.entries()) {
      const submission = submissions[index];
      let events: NonNullable<Awaited<ReturnType<typeof readConversationLog>>> = [];
      let logError: ReturnType<typeof errorIdentity> | undefined;
      try { await flushConversationLog(id); events = await readConversationLog(id) ?? []; }
      catch (error) { logError = errorIdentity(error); }
      outcomes.push({ id, status: submission.status === 'fulfilled' ? submission.value.status : 'rejected',
        error: errorIdentity(submission.status === 'fulfilled' ? submission.value.error : submission.reason),
        physicalHttpRequests: requests.get(id)?.length ?? 0, liveDispatches: liveDispatches.get(id) ?? 0,
        durable: { starts: events.filter(event => event.type === 'run:start').length,
          dispatches: events.filter(event => event.type === 'model:dispatch').length,
          done: events.filter(event => event.type === 'run:done').length }, ...(logError ? { logError } : {}) });
    }
    const diagnostic = { label, count, repetition, node: process.version, platform: process.platform,
      completedMs: completeMs, initialPressure, peakPressure, settledPressure, outcomes };
    console.info('DISPATCH_ADMISSION_DIAGNOSTIC', JSON.stringify(diagnostic));
    if (diagnosticOutput) {
      await fs.mkdir(diagnosticOutput, { recursive: true });
      await fs.writeFile(path.join(diagnosticOutput, `${label}-${count}-${repetition}-diagnostic.json`), JSON.stringify(diagnostic, null, 2));
    }
    // Capture every outcome before any assertion can hide a later refusal.
    // Fulfilled error results and rejected submissions still fail strictly.
    const results = submissions.map(submission => {
      expect(submission.status).toBe('fulfilled');
      if (submission.status === 'rejected') throw submission.reason;
      return submission.value;
    });
    const preDispatch: number[] = []; const afterStartToHttp: number[] = [];
    for (const [index, id] of ids.entries()) {
      expect(results[index].status).toBe('completed'); expect(results[index].outputText).toBe(`answer ${id}`); expect(requests.get(id)).toHaveLength(1);
      await flushConversationLog(id);
      const events = await readConversationLog(id) ?? [];
      expect((await fs.stat(path.join(logRoot, `${id}.jsonl`))).isFile()).toBe(true);
      const start = events.find(event => event.type === 'run:start'); const dispatch = events.find(event => event.type === 'model:dispatch');
      expect(start).toBeDefined(); expect(dispatch).toBeDefined(); expect(events.filter(event => event.type === 'run:done')).toHaveLength(1);
      preDispatch.push(dispatch!.timestamp - start!.timestamp); afterStartToHttp.push(requests.get(id)![0].epoch - start!.timestamp);
      const state = await loadItem<SharedState | null>(`conversations/${id}` as StorageKey, null);
      expect(state?.status).toBe('completed'); expect(state?.messages.some(message => message.content === `answer ${id}`)).toBe(true);
      const sidebar = JSON.parse(await fs.readFile(path.join(getWorkspaceDataDir(), 'db', 'conversation-summaries', `${id}.json`), 'utf8'));
      expect(sidebar).toMatchObject({ id, status: 'completed' });
    }
    const phases = Object.fromEntries([...new Set(mockSpans.map(span => span.phase))].map(phase => [phase, stats(mockSpans.filter(span => span.phase === phase).map(span => span.end - span.start))]));
    const admissions = mockSpans.filter(span => span.phase === 'writerAdmission' && span.admitted !== undefined);
    const first = Math.min(...ids.map(id => requests.get(id)![0].monotonic));
    const result = { label, count, repetition, completed: results.length, physicalHttpRequests: ids.reduce((n, id) => n + requests.get(id)!.length, 0),
      firstDispatchFromInvocationMs: first - started, preModelDispatch: stats(preDispatch), afterStartToHttp: stats(afterStartToHttp), completedMs: completeMs,
      admission: stats(admissions.map(span => span.admitted! - span.start)), phases, archivePeak: peak,
      eventLoop: { meanMs: delay.mean / 1e6, p99Ms: delay.percentile(99) / 1e6, maxMs: delay.max / 1e6 },
    };
    summaries.push(result); console.info('DISPATCH_ADMISSION_PROFILE', JSON.stringify(result));
    expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
    expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 0, reservedBytes: 0, workspaceActiveRuns: 0 });
    expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: 0, writers: 0, allocationBytes: 0,
      retainedBytes: 0, queuedWriters: 0, openBatches: 0, chains: 0, fences: 0, receipts: 0, quarantinedWriterSlots: 0 });
    expect(getAllocationReservationSnapshot().total).toBe(0);
    expect(globalThis.__flujo_workspace_writer_admission_chains?.size ?? 0).toBe(0);
    await expect(withWorkspaceRecoveryCapture(async () => 'drained')).resolves.toBe('drained');
  });
});
