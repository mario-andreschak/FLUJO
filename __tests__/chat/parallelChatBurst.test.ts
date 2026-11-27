/**
 * #757: a burst of parallel streamed /v1 chat requests through the real route,
 * real storage and locks, with a loopback stub model. Every request must reach
 * the model and answer; none may be refused because others arrived together.
 *
 * Measure other sizes with FLUJO_CHAT_BURST_COUNTS=1,50,300 (prints one
 * CHAT_BURST line per size). scripts/chat-burst-load-test.mjs runs the same
 * burst against a production build.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: () => {}, verbose: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }));
jest.setTimeout(600_000);

const BURST = 64;
const FIRST_MODEL_CALL_P95_MS = 45_000;
const measured = (process.env.FLUJO_CHAT_BURST_COUNTS ?? '').split(',').filter(Boolean).map(Number);
const ENV = ['FLUJO_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE', 'FLUJO_WRITER_LEASE_IDLE_MS', 'FLUJO_CHAT_ADMISSION_WAIT_MS'] as const;

let server: Server;
let root: string;
let baseUrl = '';
let previous: Array<string | undefined>;
const arrivals = new Map<string, number[]>();

beforeAll(async () => {
  previous = ENV.map(name => process.env[name]);
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'flujo-chat-burst-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  const secret = path.join(root, 'secret');
  await fs.writeFile(secret, randomBytes(32).toString('base64url'));
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secret;
  // Like a production server: shared writer registrations, and a wait long
  // enough that a slow shared test machine measures waiting, not refusals.
  delete process.env.FLUJO_WRITER_LEASE_IDLE_MS;
  process.env.FLUJO_CHAT_ADMISSION_WAIT_MS = '300000';
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = JSON.stringify(body.messages).match(/burst-\d+-\d+/)?.[0] ?? 'unknown';
      arrivals.set(id, [...(arrivals.get(id) ?? []), performance.now()]);
      const base = { id: 'burst', created: 1, model: 'burst' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: `answer ${id}` }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const { runWithWorkspace, ensureWorkspaceDirs } = await import('@/utils/workspace');
  const { modelService } = await import('@/backend/services/model');
  const { saveCollectionItem } = await import('@/utils/storage/backend');
  await runWithWorkspace('default-workspace', async () => {
    await ensureWorkspaceDirs();
    const saved = await modelService.addModel({ id: 'burst-model', name: 'burst', displayName: 'Burst', provider: 'openai', adapter: 'openai', ApiKey: 'loopback', baseUrl });
    expect(saved.success).toBe(true);
    await saveCollectionItem('flows', 'burst-flow', { id: 'burst-flow', name: 'burst', nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'start', type: 'start', properties: {} } },
      { id: 'process', type: 'process', position: { x: 1, y: 0 }, data: { label: 'process', type: 'process', properties: { boundModel: 'burst-model' } } },
      { id: 'finish', type: 'finish', position: { x: 2, y: 0 }, data: { label: 'finish', type: 'finish', properties: {} } },
    ], edges: [
      { id: 'a', source: 'start', target: 'process', data: { edgeType: 'standard' } },
      { id: 'b', source: 'process', target: 'finish', data: { edgeType: 'standard' } },
    ] });
  });
});

afterAll(async () => {
  await settle();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  const { flushStatisticsEvents } = await import('@/backend/services/statistics');
  await flushStatisticsEvents();
  const { retireIdleModelCatalogReader, retireIdleWorkspaceWriterRegistration } = await import('@/backend/services/enduringAgents/runtimeLock');
  const { runWithWorkspace } = await import('@/utils/workspace');
  await runWithWorkspace('default-workspace', async () => {
    await retireIdleModelCatalogReader();
    await retireIdleWorkspaceWriterRegistration();
  });
  ENV.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  });
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Runs keep saving their state briefly after the reply ends; let them finish. */
async function settle() {
  const { getFlowRunAdmissionDiagnostics } = await import('@/backend/execution/flow/runAdmission');
  for (let wait = 0; wait < 200 && getFlowRunAdmissionDiagnostics().activeRuns > 0; wait++) await new Promise(resolve => setTimeout(resolve, 50));
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);
}

async function burst(count: number) {
  const { POST } = await import('@/app/v1/chat/completions/route');
  arrivals.clear();
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const id = `burst-${count}-${index}`;
    const body = JSON.stringify({ model: 'flow-burst', stream: true, messages: [{ role: 'user', content: `Return ${id}` }] });
    const response = await POST(new NextRequest('http://localhost/v1/chat/completions', { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body }));
    const text = await response.text();
    return { id, status: response.status, answered: text.includes(`answer ${id}`), refusal: response.status >= 400 ? text.slice(0, 200) : undefined };
  }));
  const firstCalls = results.flatMap(result => arrivals.get(result.id)?.slice(0, 1).map(at => at - started) ?? []);
  return { results, firstCalls, elapsedMs: Math.round(performance.now() - started) };
}

it(`answers all ${BURST} parallel streamed chats without refusing any`, async () => {
  const { results, firstCalls } = await burst(BURST);
  const statuses: Record<number, number> = {};
  for (const result of results) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
  expect({ statuses, refusals: [...new Set(results.flatMap(result => result.refusal ? [result.refusal] : []))] })
    .toEqual({ statuses: { 200: BURST }, refusals: [] });
  expect(results.filter(result => result.answered)).toHaveLength(BURST);
  for (const result of results) expect(arrivals.get(result.id)).toHaveLength(1);
  expect(percentile(firstCalls, 0.95)).toBeLessThan(FIRST_MODEL_CALL_P95_MS);

  const { getFlowRunAdmissionDiagnostics } = await import('@/backend/execution/flow/runAdmission');
  const { executionStreamAdmission } = await import('@/backend/execution/flow/engine/executionStream');
  const { getChatIngressDiagnostics } = await import('@/utils/http/chatIngress');
  const { runWithWorkspace } = await import('@/utils/workspace');
  await settle();
  runWithWorkspace('default-workspace', () => {
    expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 0, waitingRuns: 0, reservedBytes: 0 });
  });
  expect(executionStreamAdmission.diagnostics()).toMatchObject({ waiting: 0 });
  expect(getChatIngressDiagnostics()).toMatchObject({ waiting: 0, parsing: 0 });
});

(measured.length ? it.each(measured) : it.skip.each([0]))('measures a burst of %i parallel streamed chats', async count => {
  const { results, firstCalls, elapsedMs } = await burst(count);
  const statuses: Record<number, number> = {};
  for (const result of results) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
  console.info('CHAT_BURST', JSON.stringify({ count, statuses, answered: results.filter(result => result.answered).length,
    firstModelCallMs: { p50: percentile(firstCalls, 0.5), p95: percentile(firstCalls, 0.95), max: percentile(firstCalls, 1) },
    elapsedMs }));
  await settle();
  expect(results.filter(result => result.answered)).toHaveLength(count);
});
