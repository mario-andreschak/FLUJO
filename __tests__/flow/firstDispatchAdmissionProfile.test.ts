/** #757: bounded real storage, catalog, credential and SDK profiling. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { randomBytes } from 'node:crypto';
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
import { flushConversationLog, readConversationLog } from '@/backend/execution/flow/conversationLog';
import { loadItem, saveCollectionItem } from '@/utils/storage/backend';
import { getArchiveWritePressure } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';
import { ensureWorkspaceDirs, getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import { withWorkspaceRecoveryCapture } from '@/backend/services/workspace/workspaceMutationGate';
import { modelService } from '@/backend/services/model';

jest.setTimeout(90_000);
let server: Server;
let root: string;
let previousEnvironment: Record<string, string | undefined>;
let baseUrl = '';
const requests = new Map<string, Array<{ monotonic: number; epoch: number }>>();
const summaries: unknown[] = [];
const output = process.env.FLUJO_DISPATCH_PROFILE_OUTPUT;
const label = process.env.FLUJO_DISPATCH_PROFILE_LABEL ?? 'local';
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-dispatch-admission-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  for (const key of ['FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKER_MODE', 'FLUJO_WORKER_SNAPSHOT_KEY']) delete process.env[key];
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
  FlowExecutor.conversationStates.clear(); FlowExecutor.clearFlowCache();
  if (output) { await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, `${label}-summary.json`), JSON.stringify(summaries, null, 2)); }
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});
it.each([[1, 0], [16, 1], [16, 2]])('profiles real saved-model dispatch (concurrency=%i, repetition=%i)', async (count, repetition) => {
  await runWithWorkspace(`queue-profile-${count}-${repetition}`, async () => {
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
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Bounded local dispatch deadline')), 60_000);
    const peak = { bytes: 0, writers: 0, waiters: 0 };
    const sampler = setInterval(() => {
      const pressure = getArchiveWritePressure();
      peak.bytes = Math.max(peak.bytes, pressure.bytes); peak.writers = Math.max(peak.writers, pressure.writers);
      peak.waiters = Math.max(peak.waiters, (globalThis as typeof globalThis & { __flujoArchiveWriteQueue?: unknown[] }).__flujoArchiveWriteQueue?.length ?? 0);
    }, 10);
    let results: Awaited<ReturnType<typeof runFlow>>[];
    try {
      results = await Promise.all(ids.map(conversationId => mockContext.run(conversationId, () => runFlow({ conversationId, flowId: flow.id, prompt: `Return exactly ${conversationId}. ${'filler '.repeat(500)}`, source: 'api', mode: 'conversation', abortSignal: controller.signal }))));
    } finally {
      clearTimeout(deadline); clearInterval(sampler); delay.disable(); mockMeasuring = false;
      if (inspector) {
        const { profile } = await inspectorCall<{ profile: unknown }>(inspector, 'Profiler.stop'); inspector.disconnect();
        await fs.mkdir(output!, { recursive: true }); await fs.writeFile(path.join(output!, `${label}-${count}-${repetition}.cpuprofile`), JSON.stringify(profile));
      }
    }
    const completeMs = performance.now() - started;
    const preDispatch: number[] = []; const afterStartToHttp: number[] = [];
    for (const [index, id] of ids.entries()) {
      expect(results[index].status).toBe('completed'); expect(results[index].outputText).toBe(`answer ${id}`); expect(requests.get(id)).toHaveLength(1);
      await flushConversationLog(id);
      const events = await readConversationLog(id) ?? [];
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
    expect(globalThis.__flujo_workspace_writer_admission_chains?.size ?? 0).toBe(0);
    await expect(withWorkspaceRecoveryCapture(async () => 'drained')).resolves.toBe('drained');
  });
});
