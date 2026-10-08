import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import { createArchiveOwnedFixture, removeArchiveOwnedFixture, type ArchiveOwnedFixture } from '../flow/fixtures/archiveOwnedFixture';

const queryMock = jest.fn();
let runtimeRoot: string;
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  // The boundary forwards into the actual installed SDK in its Node bridge.
  query: (...args: unknown[]) => queryMock(...args),
  tool: () => { throw new Error('Tools are outside this control'); },
  createSdkMcpServer: () => { throw new Error('MCP server is outside this control'); },
}));
jest.mock('@/backend/services/mcp', () => ({ mcpService: {
  callTool: () => { throw new Error('Unexpected host MCP'); },
} }));
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: async () => ({ home: runtimeRoot, workingDirectory: runtimeRoot, env: {} }),
}));
jest.mock('@/backend/services/runResources', () => ({ getRunResourceSettings: async () => ({}) }));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';
import { _setModelTurnArchiveDirForTests, archiveModelDispatch, readModelTurnSnapshot, updateModelDispatchOutcome } from '@/backend/execution/flow/modelTurnArchive';
import { getArchiveWritePressure, withArchiveWriteMemory } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';
import { flushStatisticsEvents } from '@/backend/services/statistics';

jest.setTimeout(30_000);
const canonical = [{ id: 'original', role: 'user' as const, content: 'retained history', timestamp: 1 }];
let fixture: ArchiveOwnedFixture;
let server: Server;
let endpoint: string;
let requests: unknown[];
let children: Array<{ process: ChildProcess; drained: Promise<void> }>;
let priorArchive: string | undefined;
let priorData: string | undefined;
let priorParent: string | undefined;
let uncertain: boolean;

beforeEach(async () => {
  fixture = await createArchiveOwnedFixture();
  runtimeRoot = fixture.root;
  priorArchive = _setModelTurnArchiveDirForTests(path.join(fixture.root, 'archives'));
  priorData = process.env.FLUJO_DATA_DIR;
  priorParent = process.env.FLUJO_PARENT_DATA_DIR;
  process.env.FLUJO_DATA_DIR = fixture.root;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  requests = [];
  children = [];
  uncertain = false;
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ text: 'done' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/provider`;
  queryMock.mockReset().mockImplementation(({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    const stream = (async function* () {
      const first = await prompt[Symbol.asyncIterator]().next();
      if (first.done) throw new Error('Claude adapter closed input before SDK forwarding');
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'claudeArchiveSdkBridge.mjs')], {
        cwd: fixture.root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
          HOME: fixture.root, USERPROFILE: fixture.root, CLAUDE_CONFIG_DIR: fixture.root,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: fixture.root },
      });
      let stderrBytes = 0;
      const stderr: Buffer[] = [];
      child.stderr!.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes <= 64 * 1024) stderr.push(Buffer.from(chunk));
        else { uncertain = true; child.kill('SIGKILL'); }
      });
      const drained = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 ? resolve()
          : reject(new Error(`Actual SDK bridge exit ${code}/${signal}; stderrBytes=${stderrBytes}`)));
      });
      drained.catch(() => undefined);
      children.push({ process: child, drained });
      const timeout = setTimeout(() => { uncertain = true; child.kill('SIGKILL'); }, 15_000);
      const output = createInterface({ input: child.stdout! });
      child.stdin!.end(JSON.stringify({ root: fixture.root, url: endpoint, prompt: first.value.message.content }));
      try {
        let total = 0;
        for await (const line of output) {
          total += line.length;
          if (total > 1024 * 1024) throw new Error('SDK bridge output exceeded fixture bound');
          yield JSON.parse(line);
        }
        await drained;
      } finally {
        output.close();
        try {
          await drained;
        } finally {
          clearTimeout(timeout);
          await fs.writeFile(path.join(fixture.root, 'sdk-bridge-stderr.log'), Buffer.concat(stderr));
        }
      }
    })();
    return Object.assign(stream, { close: () => undefined });
  });
});

afterEach(async () => {
  const errors: unknown[] = [];
  for (const child of children) {
    if (child.process.exitCode === null && child.process.signalCode === null) {
      uncertain = true;
      child.process.kill('SIGKILL');
    }
    try { await child.drained; } catch (error) { errors.push(error); }
  }
  const pressure = getArchiveWritePressure();
  const steps: Array<() => void | Promise<void>> = [
    async () => { await flushStatisticsEvents(); },
    async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
    () => { _setModelTurnArchiveDirForTests(priorArchive); },
    () => { if (priorData === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = priorData; },
    () => { if (priorParent === undefined) delete process.env.FLUJO_PARENT_DATA_DIR; else process.env.FLUJO_PARENT_DATA_DIR = priorParent; },
    async () => {
      if (errors.length || uncertain || pressure.bytes || pressure.writers || pressure.quarantined) {
        throw new Error(`Unresolved ownership; preserve ${fixture.root}`);
      }
      await removeArchiveOwnedFixture(fixture);
    },
  ];
  for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'Claude archive control cleanup failed');
});

const input = (extra: Partial<CompletionInput> = {}): CompletionInput => ({
  model: { id: 'offline', name: 'offline-model', provider: 'claude-subscription' },
  apiKey: 'offline-not-a-secret', messages: [{ role: 'user', content: canonical[0].content }],
  conversationId: 'claude-memory', nodeId: 'node', ...extra,
} as CompletionInput);

const capture: NonNullable<CompletionInput['onSdkRequest']> = async snapshot => {
  const entry = await archiveModelDispatch({
  conversationId: 'claude-memory', nodeId: 'node', modelId: 'offline', modelName: 'offline-model',
  adapter: snapshot.adapter, operation: snapshot.operation, attempt: 1,
  canonicalMessages: canonical, genericWire: [{ role: 'user', content: canonical[0].content }], sdkRequest: snapshot.request,
  });
  return entry.dispatchId;
};

it('rejects actual archive pressure before Claude query/SDK/HTTP and removes the external abort listener', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writers = Array.from({ length: 4 }, () => withArchiveWriteMemory('held', async () => { await gate; }));
  const signal = new AbortController().signal;
  const remove = jest.spyOn(signal, 'removeEventListener');
  try {
    await expect(new ClaudeSubscriptionAdapter().createCompletion(input({ signal, onSdkRequest: capture })))
      .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  } finally { release(); await Promise.allSettled(writers); remove.mockRestore(); }
});

it('archives through the actual Claude adapter and installed SDK protocol with one loopback dispatch after capacity drains', async () => {
  const result = await new ClaudeSubscriptionAdapter().createCompletion(input({ onSdkRequest: capture,
    onSdkRequestResult: ({ dispatchId, outcome }) => updateModelDispatchOutcome('claude-memory', dispatchId, outcome),
  }));
  expect(result.completion.choices[0].message.content).toBe('done');
  expect(queryMock).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(1);
  const files = (await fs.readdir(path.join(fixture.root, 'archives', 'claude-memory'))).filter(file => file.endsWith('.v2.json.gz'));
  expect(files).toHaveLength(1);
  const snapshot = await readModelTurnSnapshot('claude-memory', files[0].slice(0, -'.v2.json.gz'.length));
  expect(snapshot!.canonicalMessages).toEqual(canonical);
  expect(snapshot!.entry.outcome).toBe('completed');
  expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
});

it('preserves best-effort ordinary diagnostic failures while the actual SDK and loopback dispatch still complete', async () => {
  const result = await new ClaudeSubscriptionAdapter().createCompletion(input({
    onSdkRequest: async () => { throw new Error('Optional diagnostic failed'); },
  }));
  expect(result.completion.choices[0].message.content).toBe('done');
  expect(queryMock).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(1);
});

