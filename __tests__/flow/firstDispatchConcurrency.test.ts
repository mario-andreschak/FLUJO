/** Bounded #757 reproduction: real persistence/locks, loopback SDK, no paid provider. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Flow } from '@/shared/types/flow';
import type { SharedState } from '@/backend/execution/flow/types';
import type { StorageKey } from '@/shared/types/storage';

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
import { flushConversationLog, readConversationLog } from '@/backend/execution/flow/conversationLog';
import { loadItem, saveCollectionItem } from '@/utils/storage/backend';
import { getArchiveWritePressure } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';
import { ensureWorkspaceDirs, getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import { withWorkspaceMutation, withWorkspaceRecoveryCapture } from '@/backend/services/workspace/workspaceMutationGate';

jest.setTimeout(180_000);
let server: Server;
let root: string;
let previousDataDir: string | undefined;
const requests = new Map<string, number[]>();

beforeAll(async () => {
  previousDataDir = process.env.FLUJO_DATA_DIR;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-first-dispatch-'));
  process.env.FLUJO_DATA_DIR = root;
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
  FlowExecutor.conversationStates.clear();
  FlowExecutor.clearFlowCache();
  if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = previousDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

it.each([[false, 1], [false, 16], [false, 64], ...(process.env.FLUJO_FIRST_DISPATCH_300 === '1' ? [[false, 300]] as const : []), [true, 1], [true, 16], [true, 64]] as const)('measures saved-flow first dispatch (protected=%s, concurrency=%i)', async (protectedRun, count) => {
  await runWithWorkspace(`dispatch-${protectedRun ? 'protected' : 'ordinary'}-${count}`, async () => {
    requests.clear();
    await ensureWorkspaceDirs();
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
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Local batch deadline exceeded')), 120_000);
    const sampleMemory = setInterval(() => {
      mockArchivePeakBytes = Math.max(mockArchivePeakBytes, getArchiveWritePressure().bytes);
      mockArchivePeakWaiters = Math.max(mockArchivePeakWaiters, (globalThis as typeof globalThis & { __flujoArchiveWriteQueue?: unknown[] }).__flujoArchiveWriteQueue?.length ?? 0);
    }, 5);
    const results = await Promise.all(ids.map(conversationId => {
      return runFlow({ conversationId, flowId: flow.id, prompt: conversationId, source: 'api', mode: 'conversation',
        abortSignal: controller.signal,
        ...(protectedRun ? { executionAuthority: { signal: controller.signal, assertCurrent: async () => {} } } : {}) });
    })).finally(() => { clearTimeout(deadline); clearInterval(sampleMemory); });
    const latencies = ids.flatMap(id => (requests.get(id) ?? []).slice(0, 1).map(time => time - started)).sort((a, b) => a - b);
    console.info('FIRST_DISPATCH_BASELINE', JSON.stringify({ protectedRun, count, dispatched: latencies.length,
      completed: results.filter(result => result.status === 'completed').length,
      firstMs: Math.round(latencies[0] ?? 0), medianMs: Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0),
      lastMs: Math.round(latencies.at(-1) ?? 0), completedMs: Math.round(performance.now() - started),
      errors: [...new Set(results.filter(result => result.status !== 'completed').map(result => result.error?.details?.code ?? result.error?.message))],
      archivePressure: getArchiveWritePressure(),
      archivePeak: { bytes: mockArchivePeakBytes, waiters: mockArchivePeakWaiters },
      admission: { count: mockAdmissions.length,
        beforeFirstDispatch: mockAdmissions.filter(timing => timing.start < started + (latencies[0] ?? 0)).length,
        waitMs: Math.round(mockAdmissions.filter(timing => timing.admitted > 0).reduce((total, timing) => total + timing.admitted - timing.start, 0)),
        maxWaitMs: Math.round(Math.max(0, ...mockAdmissions.filter(timing => timing.admitted > 0).map(timing => timing.admitted - timing.start))),
      },
    }));
    for (const [index, id] of ids.entries()) {
      const result = results[index];
      if (!protectedRun) expect(result.status).toBe('completed');
      if (result.status === 'completed') {
        expect(result.outputText).toBe(`answer ${id}`);
        expect(requests.get(id)).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ status: 'error', error: { details: { code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' }, statusCode: 429 } });
        expect(requests.get(id) ?? []).toHaveLength(0);
      }
      await flushConversationLog(id);
      const state = await loadItem<SharedState | undefined>(`conversations/${id}` as StorageKey, undefined);
      expect(state).toMatchObject({ status: result.status });
      if (result.status === 'completed') {
        expect(state?.recovery?.classification).toBe('completed');
        expect(state?.messages.filter(message => message.role === 'assistant' && message.content === `answer ${id}`)).toHaveLength(1);
      }
      expect((await readConversationLog(id) ?? []).filter(event => event.type === 'run:done')).toHaveLength(1);
      const summary = JSON.parse(await fs.readFile(path.join(getWorkspaceDataDir(), 'db', 'conversation-summaries', `${id}.json`), 'utf8'));
      expect(summary).toMatchObject({ id, status: result.status });
    }
    expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
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
