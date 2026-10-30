/** Bounded #757 reproduction: real persistence/locks, loopback SDK, no paid provider. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Flow } from '@/shared/types/flow';
import type { SharedState } from '@/backend/execution/flow/types';
import { StorageKey } from '@/shared/types/storage';

let mockBaseUrl = '';
let mockArchivePeakBytes = 0;
let mockArchivePeakWaiters = 0;
const mockAdmissions: Array<{ start: number; admitted: number; end: number }> = [];
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents/runtimeLock');
  return { ...actual, withWorkspaceProcessMutation: async <T,>(task: () => Promise<T>) => {
    const timing = { start: performance.now(), admitted: 0, end: 0 };
    mockAdmissions.push(timing);
    try { return await actual.withWorkspaceProcessMutation(async () => { timing.admitted = performance.now(); return task(); }); }
    finally { timing.end = performance.now(); }
  } };
});
jest.mock('@/backend/services/model', () => ({ modelService: {
  getModel: async (id: string) => ({ id, name: 'dispatch-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }),
  loadModels: async () => [{ id: 'dispatch-model', name: 'dispatch-fixture' }], resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
} }));
// Keep benchmark output bounded; timings/errors are summarized below in memory.
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: () => {}, verbose: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { _setConversationLogDirForTests, flushConversationLog, readConversationLog } from '@/backend/execution/flow/conversationLog';
import { loadItem, saveItem, saveCollectionItem } from '@/utils/storage/backend';
import { getArchiveWritePressure } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';
import { ensureWorkspaceDirs, getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import { withWorkspaceMutation, withWorkspaceRecoveryCapture } from '@/backend/services/workspace/workspaceMutationGate';
import { getFlowRunAdmissionDiagnostics, isFlowRunPressureError } from '@/backend/execution/flow/runAdmission';
import { ConversationPublicationError, getConversationPublicationDiagnostics, publishConversation } from '@/backend/execution/flow/conversationPublication';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { flushStatisticsEvents } from '@/backend/services/statistics';

jest.setTimeout(180_000);
let server: Server;
let root: string;
let previousDataDir: string | undefined;
let previousParentDataDir: string | undefined;
let logRoot: string, previousLogRoot: string, temporaryParent: string;
let rootIdentity: BigIntStats;
const requests = new Map<string, number[]>();

function assertFixtureStorage(): void {
  const relative = path.relative(root, getWorkspaceDataDir());
  expect(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)).toBe(true);
  expect(path.resolve(logRoot)).toBe(path.join(root, 'conversation-logs'));
}

beforeAll(async () => {
  previousDataDir = process.env.FLUJO_DATA_DIR;
  previousParentDataDir = process.env.FLUJO_PARENT_DATA_DIR;
  temporaryParent = await fs.realpath(os.tmpdir());
  root = await fs.mkdtemp(path.join(temporaryParent, 'flujo-first-dispatch-'));
  rootIdentity = await fs.lstat(root, { bigint: true });
  process.env.FLUJO_DATA_DIR = root;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  // Global Jest logs use a PID path, which a later Linux sandbox can reuse.
  // Install a genuinely fresh log store owned by this fixture, retaining the
  // previous override/records intact for teardown and failure provenance.
  logRoot = path.join(root, 'conversation-logs');
  await fs.mkdir(logRoot);
  previousLogRoot = _setConversationLogDirForTests(logRoot);
  assertFixtureStorage();
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = JSON.stringify(body.messages).match(/dispatch-[op]-\d+-\d+/)?.[0];
      if (!id) { response.writeHead(400); response.end('Missing fixture identity'); return; }
      requests.set(id, [...(requests.get(id) ?? []), performance.now()]);
      const base = { id: 'fixture', created: 1, model: 'dispatch-fixture' };
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
  mockBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  process.env.FLUJO_DATA_DIR = root;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  await flushStatisticsEvents();
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: 0, writers: 0, openBatches: 0, chains: 0, fences: 0 });
  FlowExecutor.conversationStates.clear();
  FlowExecutor.clearFlowCache();
  const current = await fs.lstat(root, { bigint: true });
  const relative = path.relative(temporaryParent, path.resolve(root));
  if (relative !== path.basename(root) || !relative.startsWith('flujo-first-dispatch-')
    || current.isSymbolicLink() || !current.isDirectory() || await fs.realpath(root) !== root
    || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || current.birthtimeNs !== rootIdentity.birthtimeNs) {
    throw new Error('Preserving replaced or unowned dispatch fixture');
  }
  _setConversationLogDirForTests(previousLogRoot);
  if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = previousDataDir;
  if (previousParentDataDir === undefined) delete process.env.FLUJO_PARENT_DATA_DIR;
  else process.env.FLUJO_PARENT_DATA_DIR = previousParentDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

it.each([[false, 1], [false, 16], [false, 64], ...(process.env.FLUJO_FIRST_DISPATCH_300 === '1' ? [[false, 300]] as const : []), [true, 1], [true, 16], [true, 64]] as const)('measures saved-flow first dispatch (protected=%s, concurrency=%i)', async (protectedRun, count) => {
  await runWithWorkspace(`dispatch-${protectedRun ? 'protected' : 'ordinary'}-${count}`, async () => {
    assertFixtureStorage();
    requests.clear();
    await ensureWorkspaceDirs();
    await saveItem(StorageKey.MODELS, [{ id: 'dispatch-model', name: 'dispatch-fixture',
      provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }]);
    const flow: Flow = { id: 'dispatch-saved-flow', name: 'dispatch-fixture',
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'start', type: 'start', properties: {} } },
        { id: 'process', type: 'process', position: { x: 1, y: 0 }, data: { label: 'process', type: 'process', properties: { boundModel: 'dispatch-model' } } },
      ], edges: [{ id: 'edge', source: 'start', target: 'process', data: { edgeType: 'standard' } }],
    };
    await saveCollectionItem('flows', flow.id, flow);
    mockAdmissions.length = 0;
    mockArchivePeakBytes = 0; mockArchivePeakWaiters = 0;
    const started = performance.now();
    const ids = Array.from({ length: count }, (_, index) => `dispatch-${protectedRun ? 'p' : 'o'}-${count}-${index}`);
    const logicalDispatches = new Map<string, number>();
    const unsubscribeDispatches = executionEventBus.subscribeGlobal(({ event }) => {
      if (event.type === 'model:dispatch') logicalDispatches.set(event.conversationId, (logicalDispatches.get(event.conversationId) ?? 0) + 1);
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Local batch deadline exceeded')), 120_000);
    const sampleMemory = setInterval(() => {
      mockArchivePeakBytes = Math.max(mockArchivePeakBytes, getArchiveWritePressure().bytes);
      mockArchivePeakWaiters = Math.max(mockArchivePeakWaiters, (globalThis as typeof globalThis & { __flujoArchiveWriteQueue?: unknown[] }).__flujoArchiveWriteQueue?.length ?? 0);
    }, 5);
    const submissions = await Promise.allSettled(ids.map(conversationId => {
      return runFlow({ conversationId, flowId: flow.id, prompt: conversationId, source: 'api', mode: 'conversation',
        abortSignal: controller.signal,
        ...(protectedRun ? { executionAuthority: { signal: controller.signal, assertCurrent: async () => {} } } : {}) });
    })).finally(() => { clearTimeout(deadline); clearInterval(sampleMemory); unsubscribeDispatches(); });
    const results = submissions.flatMap(submission => submission.status === 'fulfilled' ? [submission.value] : []);
    const refused = submissions.filter(submission => submission.status === 'rejected');
    const latencies = ids.flatMap(id => (requests.get(id) ?? []).slice(0, 1).map(time => time - started)).sort((a, b) => a - b);
    console.info('FIRST_DISPATCH_BASELINE', JSON.stringify({ protectedRun, count, dispatched: latencies.length,
      completed: results.filter(result => result.status === 'completed').length, refusedBeforeExecution: refused.length,
      firstMs: Math.round(latencies[0] ?? 0), medianMs: Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0),
      lastMs: Math.round(latencies.at(-1) ?? 0), completedMs: Math.round(performance.now() - started),
      errors: [...new Set(results.filter(result => result.status !== 'completed').map(result => result.error?.details?.code ?? result.error?.message))],
      archivePressure: getArchiveWritePressure(),
      publicationPressure: getConversationPublicationDiagnostics(),
      archivePeak: { bytes: mockArchivePeakBytes, waiters: mockArchivePeakWaiters },
      admission: { count: mockAdmissions.length,
        beforeFirstDispatch: mockAdmissions.filter(timing => timing.start < started + (latencies[0] ?? 0)).length,
        waitMs: Math.round(mockAdmissions.filter(timing => timing.admitted > 0).reduce((total, timing) => total + timing.admitted - timing.start, 0)),
        maxWaitMs: Math.round(Math.max(0, ...mockAdmissions.filter(timing => timing.admitted > 0).map(timing => timing.admitted - timing.start))),
      },
    }));
    for (const [index, id] of ids.entries()) {
      const submission = submissions[index];
      if (submission.status === 'rejected') {
        expect(isFlowRunPressureError(submission.reason)).toBe(true);
        expect(submission.reason).toMatchObject({ code: 'FLOW_RUN_BUSY', status: 429 });
        expect(requests.get(id) ?? []).toHaveLength(0);
        expect(FlowExecutor.conversationStates.has(id)).toBe(false);
        await expect(loadItem(`conversations/${id}` as StorageKey, undefined)).resolves.toBeUndefined();
        expect(await readConversationLog(id) ?? []).toHaveLength(0);
        await expect(fs.stat(path.join(getWorkspaceDataDir(), 'db', 'conversation-summaries', `${id}.json`)))
          .rejects.toMatchObject({ code: 'ENOENT' });
        continue;
      }
      const result = submission.value;
      if (count <= 16) expect(result.status).toBe('completed');
      if (result.status === 'completed') {
        expect(result.outputText).toBe(`answer ${id}`);
        expect(requests.get(id)).toHaveLength(1);
      } else {
        // Both local admission boundaries may refuse this oversubscribed batch.
        // Neither refusal may be accepted after a logical or physical dispatch.
        expect(result).toMatchObject({ status: 'error', error: { statusCode: 429 } });
        expect(result.error?.details?.code).toBe('MODEL_TURN_ARCHIVE_MEMORY_BUSY');
        expect(requests.get(id) ?? []).toHaveLength(0);
        expect(logicalDispatches.get(id) ?? 0).toBe(0);
      }
      await flushConversationLog(id);
      const state = await loadItem<SharedState | undefined>(`conversations/${id}` as StorageKey, undefined);
      expect(state).toMatchObject({ status: result.status });
      if (result.status === 'completed') {
        expect(state?.recovery?.classification).toBe('completed');
        expect(state?.messages.filter(message => message.role === 'assistant' && message.content === `answer ${id}`)).toHaveLength(1);
      }
      const events = await readConversationLog(id) ?? [];
      expect((await fs.stat(path.join(logRoot, `${id}.jsonl`))).isFile()).toBe(true);
      expect(events.filter(event => event.type === 'run:done')).toHaveLength(1);
      if (result.status !== 'completed') expect(events.filter(event => event.type === 'model:dispatch')).toHaveLength(0);
      const summary = JSON.parse(await fs.readFile(path.join(getWorkspaceDataDir(), 'db', 'conversation-summaries', `${id}.json`), 'utf8'));
      expect(summary).toMatchObject({ id, status: result.status });
    }
    expect(results.filter(result => result.status === 'completed').length).toBeGreaterThan(0);
    expect(refused).toHaveLength(Math.max(0, count - getFlowRunAdmissionDiagnostics().maxWorkspaceRuns));
    expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 0, reservedBytes: 0, workspaceActiveRuns: 0 });
    expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
    expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: 0, writers: 0, allocationBytes: 0,
      retainedBytes: 0, queuedWriters: 0, openBatches: 0, chains: 0, fences: 0, receipts: 0, quarantinedWriterSlots: 0 });
    expect(globalThis.__flujo_workspace_writer_admission_chains?.size ?? 0).toBe(0);
    await expect(withWorkspaceRecoveryCapture(async () => 'drained')).resolves.toBe('drained');
  });
});

it('keeps recovery capture behind a live admitted writer', async () => {
  await runWithWorkspace('dispatch-capture', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const writer = withWorkspaceMutation(async () => { entered(); await held; });
    await admitted;
    let captured = false;
    const capture = withWorkspaceRecoveryCapture(async () => { captured = true; });
    try { await new Promise(resolve => setTimeout(resolve, 25)); expect(captured).toBe(false); }
    finally { release(); }
    await writer;
    await capture;
    expect(captured).toBe(true);
  });
});

it.each([false, true])('finishes durable terminal history after an already-started run meets temporary publication pressure (prior failure=%s)', async priorFailure => {
  await runWithWorkspace(`dispatch-terminal-pressure-${priorFailure}`, async () => {
    await ensureWorkspaceDirs();
    const id = `dispatch-o-1-terminal-${priorFailure}`;
    await saveItem(StorageKey.MODELS, [{ id: 'dispatch-model', name: 'dispatch-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }]);
    const flow: Flow = { id: `terminal-pressure-flow-${priorFailure}`, name: 'terminal pressure',
      nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'start', type: 'start', properties: {} } },
        ...(!priorFailure ? [{ id: 'process', type: 'process', position: { x: 1, y: 0 }, data: { label: 'process', type: 'process', properties: { boundModel: 'dispatch-model' } } }] : [])],
      edges: priorFailure ? [] : [{ id: 'edge', source: 'start', target: 'process', data: { edgeType: 'standard' } }] };
    await saveCollectionItem('flows', flow.id, flow);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const holders: Promise<void>[] = [];
    const unsubscribe = executionEventBus.subscribe(id, event => {
      if (event.type === 'run:start') {
        for (let index = 0; index < 200; index++) {
          holders.push(publishConversation('terminal-pressure-holder', null, async () => blocked));
        }
        entered();
      }
    });
    const pending = runFlow({ conversationId: id, flowId: flow.id, prompt: 'retain this accepted input', source: 'api', mode: 'conversation' });
    try {
      await started;
      await new Promise(resolve => setTimeout(resolve, 25));
    } finally { release(); await Promise.all(holders); }
    const result = await pending.finally(unsubscribe);
    await flushConversationLog(id);
    const events = await readConversationLog(id) ?? [];
    const snapshot = await loadItem<SharedState | undefined>(`conversations/${id}` as StorageKey, undefined);
    const summary = JSON.parse(await fs.readFile(path.join(getWorkspaceDataDir(), 'db', 'conversation-summaries', `${id}.json`), 'utf8'));
    console.info('TERMINAL_PUBLICATION_PRESSURE', JSON.stringify({ status: result.status, code: result.error?.details?.code,
      events: events.map(event => event.type), snapshotStatus: snapshot?.status, summaryStatus: summary.status,
      messageCount: snapshot?.messages.length, publication: getConversationPublicationDiagnostics() }));
    // Queue pressure is not a failure: the run proceeds and its history lands.
    expect(events.filter(event => event.type === 'run:start')).toHaveLength(1);
    expect(events.filter(event => event.type === 'run:done')).toHaveLength(1);
    expect(snapshot?.messages.filter(message => message.content === 'retain this accepted input')).toHaveLength(1);
    expect(JSON.stringify(result.error ?? null)).not.toContain('CONVERSATION_PUBLICATION');
    if (priorFailure) {
      expect(result).toMatchObject({ status: 'error', error: { details: { code: 'flow_invalid' }, statusCode: 400 } });
      expect(events.filter(event => event.type === 'model:dispatch')).toHaveLength(0);
      expect(snapshot).toMatchObject({ status: 'error', lastError: { code: 'flow_invalid' } });
      expect(summary).toMatchObject({ id, status: 'error' });
    } else {
      expect(events.filter(event => event.type === 'model:dispatch')).toHaveLength(1);
      expect(snapshot?.status).toBe(result.status);
      expect(summary).toMatchObject({ id, status: result.status });
    }
    expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 0, reservedBytes: 0 });
    expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: 0, writers: 0, retainedBytes: 0, allocationBytes: 0,
      chains: 0, fences: 0, receipts: 0, quarantinedWriterSlots: 0, openBatches: 0 });
  });
});

it('does not replay an opaque emitter that throws a publication refusal after forwarding the terminal event', async () => {
  await runWithWorkspace('dispatch-opaque-terminal', async () => {
    await ensureWorkspaceDirs();
    const id = 'opaque-terminal', flow: Flow = { id: 'opaque-invalid-flow', name: 'opaque emitter', nodes: [], edges: [] };
    await saveCollectionItem('flows', flow.id, flow);
    const refusal = new ConversationPublicationError('CONVERSATION_PUBLICATION_MEMORY', 'publication allocation capacity is occupied');
    const emit = executionEventBus.emitterFor(id);
    let terminalCalls = 0;
    const result = await runFlow({ conversationId: id, flowId: flow.id, prompt: 'opaque input', source: 'api', mode: 'conversation',
      emit: event => {
        emit(event);
        if (event.type === 'run:done') { terminalCalls++; throw refusal; }
      } });
    await flushConversationLog(id);
    expect(result).toMatchObject({ status: 'error', error: { details: { code: 'flow_invalid' } } });
    expect(terminalCalls).toBe(1);
    expect((await readConversationLog(id) ?? []).filter(event => event.type === 'run:done')).toHaveLength(1);
    expect(await loadItem(`conversations/${id}` as StorageKey, undefined)).toMatchObject({ status: 'error' });
    expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: 0, openBatches: 0, chains: 0, fences: 0, receipts: 0 });
  });
});
