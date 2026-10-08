import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { PerformanceObserver } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import os from 'node:os';
import path from 'node:path';
import type { Flow } from '@/shared/types/flow';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { SubflowInvocation, SubflowNodePrepResult } from '@/backend/execution/flow/types';
import { createArchiveOwnedFixture } from './fixtures/archiveOwnedFixture';

// This switch exists only in this disposable test worker. No production bypass.
const control = process.env.FLUJO_520_WORKER === 'admission-off';
jest.mock('@/backend/execution/flow/modelTurnArchiveWriteBudget', () => {
  const actual = jest.requireActual<typeof import('@/backend/execution/flow/modelTurnArchiveWriteBudget')>(
    '@/backend/execution/flow/modelTurnArchiveWriteBudget');
  if (process.env.FLUJO_520_WORKER !== 'admission-off') return actual;
  const fileSystem = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...actual,
    reserveArchiveSnapshot: () => ({ grow: () => undefined, release: () => undefined }),
    withArchiveWriteMemory: async (_payload: unknown, task: () => Promise<unknown>) => task(),
    recheckArchiveWriteMemory: () => undefined,
    getArchiveSchemaProjectionPolicy: () => 'legacy-unbounded',
    readArchiveLocalMedia: (file: string) => fileSystem.promises.readFile(file),
  };
});
const getModelMock = jest.fn();
const getFlowMock = jest.fn();
jest.mock('@/backend/services/model', () => ({ modelService: {
  getModel: (...args: unknown[]) => getModelMock(...args),
  resolveAndDecryptApiKey: async () => 'offline-fixture',
} }));
jest.mock('@/backend/services/flow', () => ({ flowService: {
  getFlow: (...args: unknown[]) => getFlowMock(...args),
  readFlowExecutionSnapshot: async (id: string) => ({ workspaceId: 'default', flow: await getFlowMock(id) }),
} }));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => new ObservedDefaultAdapter(),
}));

import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { runSubflowLanes } from '@/backend/execution/flow/nodes/SubflowNode';
import { persistSubflowParent } from '@/backend/execution/flow/subflowRecovery';
import { _setModelTurnArchiveDirForTests, readModelTurnSnapshot, archiveModelDispatch, readModelTurnMedia } from '@/backend/execution/flow/modelTurnArchive';
import { getArchiveWritePressure } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';

let observations = 0;
const observationsByModel: Record<string, number> = {};
class ObservedDefaultAdapter extends OpenAiAdapter {
  // The real adapter's createClient and both SDK/application retry settings remain unchanged.
  async createCompletion(input: CompletionInput) {
    return super.createCompletion({ ...input, onSdkRequest: async snapshot => {
      observations++;
      observationsByModel[input.model.name] = (observationsByModel[input.model.name] ?? 0) + 1;
      return input.onSdkRequest?.(snapshot);
    } });
  }
  async createStreamCompletion(input: CompletionInput) {
    return super.createStreamCompletion({ ...input, onSdkRequest: async snapshot => {
      observations++;
      observationsByModel[input.model.name] = (observationsByModel[input.model.name] ?? 0) + 1;
      return input.onSdkRequest?.(snapshot);
    } });
  }
}
const characters = [3_600_000, 4_000_000, 4_400_000, 4_800_000, 5_200_000, 5_600_000, 3_800_000, 4_200_000];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function history(id: string, length: number): FlujoChatMessage[] {
  // Fixed ASCII four-character/token proxy, not a tokenizer or the missing original transcript.
  const block = Buffer.alloc(64 * 1024);
  let state = 0x520;
  for (const character of id) state = (Math.imul(state, 31) + character.charCodeAt(0)) >>> 0;
  for (let i = 0; i < block.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    block[i] = 33 + (state >>> 16) % 90;
  }
  const text = block.toString('ascii');
  return [{ id, role: 'user', timestamp: 1, content: (text.repeat(Math.ceil(length / text.length))).slice(0, length) }];
}
function flow(id: string): Flow {
  return { id, name: id, nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { type: 'start', label: 'Start', properties: {} } },
    { id: 'process', type: 'process', position: { x: 100, y: 0 }, data: { type: 'process', label: 'Process',
      properties: { boundModel: id, promptTemplate: 'Return a short completion.', compactionMode: 'off' } } },
  ], edges: [{ id: 'start-process', source: 'start', target: 'process' }] };
}

async function workerScenario(root: string) {
  const resolved = await fs.realpath(root);
  if (resolved !== path.resolve(root) || path.dirname(resolved) !== await fs.realpath(os.tmpdir())
      || !path.basename(resolved).startsWith('flujo-archive-control-')) throw new Error('Unowned workload root');
  process.env.FLUJO_DATA_DIR = resolved;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  _setModelTurnArchiveDirForTests(path.join(resolved, 'archives'));
  const started = performance.now();
  let phase = 'setup';
  let gcCount = 0, gcDurationMs = 0;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) { gcCount++; gcDurationMs += entry.duration; }
  });
  observer.observe({ entryTypes: ['gc'] });
  const sample = () => process.stdout.write(`FLUJO_520_SAMPLE ${JSON.stringify({
    elapsedMs: performance.now() - started, phase, ...process.memoryUsage(),
    gcCount, gcDurationMs, pressure: getArchiveWritePressure(),
  })}\n`);
  sample();
  const timer = setInterval(sample, 100);
  const cgroup: Record<string, string | null> = {};
  const physical: Record<string, number> = {};
  let server: Server | undefined;
  let completed = false;
  const originals = [history('parent-history', 2_000_000), ...characters.map((size, i) => history(`child-${i}-history`, size))];
  const hashes = originals.map(messages => digest(messages[0].content as string));
  const setupHistories = originals.map((_messages, i) => history(`setup-${i}`, 1024));
  const setupHashes = setupHistories.map(messages => digest(messages[0].content as string));
  try {
    for (const file of ['memory.max', 'memory.current', 'memory.peak', 'memory.events']) {
      try { cgroup[file] = await fs.readFile(`/sys/fs/cgroup/${file}`, 'utf8'); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        cgroup[file] = null;
      }
    }
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) throw new Error('Offline body exceeded fixture allowance');
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean };
        physical[body.model] = (physical[body.model] ?? 0) + 1;
        response.setHeader('Content-Type', 'application/json');
        if (body.model === 'child-3') {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: { message: 'AtlasCloud offline 400 bad request' } }));
        } else if (['child-4', 'retry-control'].includes(body.model) && physical[body.model] === 1) {
          response.statusCode = 429;
          response.setHeader('retry-after-ms', '1');
          response.end(JSON.stringify({ error: { message: 'Offline retry control' } }));
        } else if (body.stream) {
          response.setHeader('Content-Type', 'text/event-stream');
          const chunk = { id: 'offline', object: 'chat.completion.chunk', created: 1, model: body.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'completed offline' }, finish_reason: null }] };
          response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        } else {
          response.end(JSON.stringify({ id: 'offline', object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'completed offline' } }] }));
        }
      } catch (error) { response.statusCode = 500; response.end(String(error)); }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    getModelMock.mockImplementation(async (id: string) => ({ id, name: id, displayName: id, provider: 'openai',
      adapter: 'openai', ApiKey: 'offline-fixture', baseUrl, inputModalities: ['text'], outputModalities: ['text'] }));
    getFlowMock.mockImplementation(async (id: string) => flow(id));
    phase = 'parent-and-three-completed-one-400';
    const parent = await runFlow({ flowDefinition: flow('parent'), conversationId: 'parent', source: 'api',
      mode: 'conversation', messages: setupHistories[0], requireApproval: false, debug: false });
    expect(parent.status).toBe('completed');
    parent.sharedState.messages = originals[0];
    for (let i = 0; i < 4; i++) {
      const child = await runFlow({ flowDefinition: flow(`child-${i}`), conversationId: `child-${i}`, source: 'subflow',
        mode: 'conversation', messages: setupHistories[i + 1], parentRunId: 'parent', depth: 1, debug: false });
      expect(child.status).toBe(i === 3 ? 'error' : 'completed');
      // Restore the reported retained-history shape into the controlled durable
      // starting state. No claim that these large histories produced its setup outcomes.
      child.sharedState.messages = originals[i + 1];
      FlowExecutor.conversationStates.set(`child-${i}`, child.sharedState);
      await persistSubflowParent(child.sharedState);
    }
    const invocation: SubflowInvocation = { version: 1, id: 'original-queue', parentConversationId: 'parent',
      parentNodeId: 'subflow', parentRunId: 'parent', status: 'running', depth: 1, showSteps: false,
      concurrencyLimit: 4, joinSeparator: '\n', errorStrategy: 'collect-all', createdAt: 1, updatedAt: 1,
      lanes: characters.map((_size, i) => ({ id: `lane-${i}`, laneId: `lane-${i}`, subflowId: `child-${i}`,
        conversationId: `child-${i}`, index: i, count: 8, status: i < 3 ? 'completed' : i === 3 ? 'error' : 'pending',
        attempt: i < 4 ? 1 : 0, updatedAt: 1, input: { messages: originals[i + 1] },
        ...(i < 3 ? { outputText: 'completed offline' } : {}) })) };
    parent.sharedState.status = 'running';
    parent.sharedState.subflowInvocations = { [invocation.id]: invocation };
    FlowExecutor.conversationStates.set('parent', parent.sharedState);
    await persistSubflowParent(parent.sharedState);
    phase = 'large-parent-model-boundary';
    const parentAttempt = await (ModelHandler as unknown as { generateCompletion: (
      model: string, prompt: string, messages: FlujoChatMessage[], tools: undefined, options: Record<string, unknown>,
    ) => Promise<{ success: boolean; error?: { code: string } }> }).generateCompletion('large-parent', '', originals[0], undefined,
      { archiveModelTurns: true, canonicalMessages: originals[0], conversationId: 'large-parent', nodeId: 'process', runId: 'parent' });
    if (!parentAttempt.success) expect(parentAttempt.error?.code).toMatch(/^MODEL_TURN_ARCHIVE_MEMORY_(LIMIT|BUSY)$/);
    phase = 'three-complete-one-400-four-queued'; sample();
    const prep: SubflowNodePrepResult = { nodeId: 'subflow', nodeType: 'subflow', depth: 1, parentRunId: 'parent',
      invocationId: invocation.id, showSteps: false, persistConversation: true, concurrencyLimit: 4,
      errorStrategy: 'collect-all', lanes: invocation.lanes };
    const queue = await runSubflowLanes(prep, runFlow, { nodeId: 'subflow', nodeName: 'Offline queue', nodeType: 'subflow' },
      { messages: originals[0] });
    expect(queue.lanes).toHaveLength(8);
    expect(queue.lanes!.slice(0, 3).every(lane => lane.success)).toBe(true);
    expect(physical['child-0']).toBe(1); // Completed durable jobs were not executed twice.
    expect(physical['child-3']).toBeGreaterThanOrEqual(1);
    // When admitted, one SDK request observation includes a real SDK retry.
    if (physical['child-4']) expect(physical['child-4']).toBe(2);
    for (let i = 0; i < originals.length; i++) expect(digest(originals[i][0].content as string)).toBe(hashes[i]);
    phase = 'verify-canonical-archives';
    let archiveCount = 0;
    for (let i = 0; i < 9; i++) {
      const conversation = i === 0 ? 'parent' : `child-${i - 1}`;
      const directory = path.join(resolved, 'archives', conversation);
      let files: string[];
      try { files = await fs.readdir(directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      for (const file of files.filter(name => name.endsWith('.v2.json.gz'))) {
        const snapshot = await readModelTurnSnapshot(conversation, file.slice(0, -'.v2.json.gz'.length));
        const original = snapshot!.canonicalMessages.find(message => message.id === originals[i][0].id);
        const setup = snapshot!.canonicalMessages.find(message => message.id === setupHistories[i][0].id);
        expect(original ?? setup).toBeDefined();
        expect(digest((original ?? setup)!.content as string)).toBe(original ? hashes[i] : setupHashes[i]);
        archiveCount++;
      }
    }
    expect(archiveCount).toBeGreaterThanOrEqual(5);
    phase = 'explicit-refusal-before-sdk';
    const priorPhysical = Object.values(physical).reduce((sum, count) => sum + count, 0);
    const oversized = history('refusal-history', 7_000_000);
    const result = await (ModelHandler as unknown as { generateCompletion: (
      model: string, prompt: string, messages: FlujoChatMessage[], tools: undefined, options: Record<string, unknown>,
    ) => Promise<{ success: boolean; error?: { code: string } }> }).generateCompletion('refusal', '', oversized, undefined,
      { archiveModelTurns: true, canonicalMessages: oversized, conversationId: 'refusal', nodeId: 'process', runId: 'refusal' });
    if (!control) {
      expect(result).toMatchObject({ success: false, error: { code: 'MODEL_TURN_ARCHIVE_MEMORY_LIMIT' } });
      expect(Object.values(physical).reduce((sum, count) => sum + count, 0)).toBe(priorPhysical);
    } else expect(result.success).toBe(true);
    phase = 'default-sdk-retry-control';
    const retryMessages = history('retry-history', 1024);
    const retryResult = await (ModelHandler as unknown as { generateCompletion: (
      model: string, prompt: string, messages: FlujoChatMessage[], tools: undefined, options: Record<string, unknown>,
    ) => Promise<{ success: boolean }> }).generateCompletion('retry-control', '', retryMessages, undefined,
      { archiveModelTurns: true, canonicalMessages: retryMessages, conversationId: 'retry-control', nodeId: 'process', runId: 'retry-control' });
    expect(retryResult.success).toBe(true);
    expect(physical['retry-control']).toBe(2);
    expect(observationsByModel['retry-control']).toBe(1);
    expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
    phase = 'actual-media-write-read';
    const mediaBytes = Buffer.alloc(64 * 1024, 0x52);
    const mediaEntry = await archiveModelDispatch({ conversationId: 'media-control', nodeId: 'process', modelId: 'offline',
      modelName: 'offline', adapter: 'offline', operation: 'media-control', attempt: 1, canonicalMessages: originals[0],
      genericWire: [], sdkRequest: { image: `data:image/png;base64,${mediaBytes.toString('base64')}` } });
    const mediaSnapshot = await readModelTurnSnapshot('media-control', mediaEntry.id);
    expect(mediaSnapshot!.media).toHaveLength(1);
    const restoredMedia = await readModelTurnMedia('media-control', mediaEntry.id, mediaSnapshot!.media[0].id);
    expect(restoredMedia!.bytes.equals(mediaBytes)).toBe(true);
    for (const file of ['memory.max', 'memory.current', 'memory.peak', 'memory.events']) {
      if (cgroup[file] !== null) cgroup[file] = await fs.readFile(`/sys/fs/cgroup/${file}`, 'utf8');
    }
    phase = 'drained'; sample();
    await fs.writeFile(path.join(resolved, 'proof.json'), JSON.stringify({ control, physical, observations, observationsByModel, archiveCount,
      hashes, setupHashes, parentAttempt, characters, parentCharacters: 2_000_000, initialTopology: [3, 1, 4], queue: queue.lanes!.map(lane => ({
        success: lane.success, error: lane.error, conversationId: lane.conversationId })),
      node: process.version, platform: process.platform, arch: process.arch, execArgv: process.execArgv,
      nodeOptions: process.env.NODE_OPTIONS ?? null, heapSizeLimit: getHeapStatistics().heap_size_limit,
      installedOpenAI: JSON.parse(await fs.readFile(require.resolve('openai/package.json'), 'utf8')).version,
      pressure: getArchiveWritePressure(), gcCount, gcDurationMs, elapsedMs: performance.now() - started,
      cgroup, osRelease: os.release(), osTotalMemory: os.totalmem(), mediaRoundTripBytes: mediaBytes.length,
      lockSha256: digest(await fs.readFile(path.join(process.cwd(), 'package-lock.json'), 'utf8')),
      installedSdkEntrySha256: digest(await fs.readFile(require.resolve('openai'), 'utf8')),
      limitation: 'Synthetic four-character/token proxy; not original transcript or original fatal cause proof.' }, null, 2));
    completed = true;
  } finally {
    clearInterval(timer); observer.disconnect();
    if (server?.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
    await fs.writeFile(path.join(resolved, 'worker-settlement.json'), JSON.stringify({ completed, phase, pressure: getArchiveWritePressure() }));
    // Preserve all evidence. This worker does not delete any fixture or clear live histories.
  }
}

let resourceProfile: unknown;
if (process.env.FLUJO_520_WORKER) {
  it('executes the complete offline original-shape proxy in its disposable process', async () => {
    const root = process.env.FLUJO_520_ROOT;
    if (!root || !['admission-on', 'admission-off'].includes(process.env.FLUJO_520_WORKER!)) throw new Error('Invalid worker contract');
    await workerScenario(root);
  }, 600_000);
} else {
  it.each(['admission-on', 'admission-off'])('samples the %s process with default heap and preserves its evidence', async mode => {
    const owned = await createArchiveOwnedFixture();
    const checkout = await fs.realpath(process.cwd());
    const cli = await fs.realpath(require.resolve('jest/bin/jest'));
    const modules = await fs.realpath(path.join(checkout, 'node_modules'));
    const relative = path.relative(modules, cli);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Jest is outside this checkout');
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath,
      [cli, '--selectProjects', 'node', '--runInBand', '--runTestsByPath', __filename], {
        cwd: checkout, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
          NODE_ENV: 'test', FLUJO_520_WORKER: mode, FLUJO_520_ROOT: owned.root },
      });
    child.stdin.end();
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, timedOut = false;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= 32 * 1024 * 1024) target.push(Buffer.from(chunk));
      else { timedOut = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    let spawnError: string | undefined;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', error => { spawnError = String(error); });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 610_000);
    try {
      const exit = await closed;
      await fs.writeFile(path.join(owned.root, 'stdout.log'), Buffer.concat(stdout));
      await fs.writeFile(path.join(owned.root, 'stderr.log'), Buffer.concat(stderr));
      await fs.writeFile(path.join(owned.root, 'parent-exit.json'), JSON.stringify({ mode, exit, timedOut, outputBytes, spawnError,
        processAndStdioClosed: true, root: owned.root, dev: String(owned.identity.dev), ino: String(owned.identity.ino),
        birthtimeNs: String(owned.identity.birthtimeNs), evidencePreserved: true }));
      process.stdout.write(`FLUJO_520_EVIDENCE ${owned.root}\n`);
      // Neither timeout nor arbitrary child failure is accepted as an OOM proof.
      if (spawnError || timedOut || exit.code !== 0 || exit.signal !== null) throw new Error(`Workload failed; evidence preserved: ${owned.root}`);
      const proof = JSON.parse(await fs.readFile(path.join(owned.root, 'proof.json'), 'utf8'));
      expect(proof.nodeOptions).toBeNull();
      expect(proof.execArgv.some((argument: string) => argument.includes('max-old-space-size'))).toBe(false);
      expect(proof.initialTopology).toEqual([3, 1, 4]);
      expect(proof.pressure).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
      const currentProfile = { node: proof.node, platform: proof.platform, arch: proof.arch,
        osRelease: proof.osRelease, heapSizeLimit: proof.heapSizeLimit, installedOpenAI: proof.installedOpenAI,
        lockSha256: proof.lockSha256, installedSdkEntrySha256: proof.installedSdkEntrySha256,
        cgroupMax: proof.cgroup['memory.max'] };
      if (mode === 'admission-on') resourceProfile = currentProfile;
      else { expect(resourceProfile).toBeDefined(); expect(currentProfile).toEqual(resourceProfile); }
    } finally { clearTimeout(timeout); }
  }, 620_000);
}
