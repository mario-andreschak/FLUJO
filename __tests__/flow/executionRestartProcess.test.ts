import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';

jest.setTimeout(60_000);

type Report = {
  kind: string;
  pid: number;
  parentPid: number;
  instanceId: string;
  status?: string;
  runId?: string;
  attemptId?: string;
  outputText?: string;
  observations: string[];
  error?: string;
};
type OwnedChild = { child: ChildProcess; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; report: Promise<Report> };
const children: OwnedChild[] = [];
let sandbox: string;
let server: Server;
let endpoint: string;
let physicalRequests: Record<string, unknown>[];

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-execution-process-ordering-'));
  physicalRequests = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      physicalRequests.push(body);
      const completion = { id: 'restart-completion', object: 'chat.completion', created: 1, model: 'restart-fixture' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [
        { index: 0, delta: { role: 'assistant', content: 'restart fixture answer' }, finish_reason: null },
      ] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [
        { index: 0, delta: {}, finish_reason: 'stop' },
      ] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  const ownedChildren = children.splice(0);
  for (const owned of ownedChildren) {
    if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill('SIGKILL');
    await owned.exit;
  }
  console.info('CODE_HEALTH_RESTART_PROCESS_CLEANUP_TRACE', JSON.stringify({ physicalRequests: physicalRequests.length,
    childExits: ownedChildren.map(({ child }) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })),
  }));
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // Only the root allocated by this fixture can be removed.
  const resolvedSandbox = path.resolve(sandbox);
  if (path.dirname(resolvedSandbox) !== path.resolve(os.tmpdir()) || !path.basename(resolvedSandbox).startsWith('flujo-execution-process-ordering-')) {
    throw new Error('Unsafe execution-process fixture cleanup');
  }
  await fs.rm(resolvedSandbox, { recursive: true, force: true });
});

function start(phase: 'pause' | 'resume', conversationId: string): OwnedChild {
  const child = spawn(process.execPath, [path.resolve(__dirname, 'fixtures/executionRestartProcess.cjs'), phase, conversationId, endpoint], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_ENV: 'test', FLUJO_DATA_DIR: sandbox },
  });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  // Drain ordinary source diagnostics; IPC carries the typed witness only.
  child.stdout!.resume();
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const report = new Promise<Report>((resolve, reject) => {
    child.once('error', reject);
    child.on('message', value => {
      const observation = value as Report;
      if (observation.kind === 'failed') reject(new Error(`${observation.error}\n${stderr}\n${JSON.stringify(observation)}`));
      else resolve(observation);
    });
    child.once('exit', code => { if (code !== 0) reject(new Error(`Execution fixture exit ${code}: ${stderr}`)); });
  });
  const owned = { child, exit, report };
  children.push(owned);
  return owned;
}

function expectOrdered(trace: string[], expected: string[]) {
  let cursor = -1;
  for (const operation of expected) {
    const next = trace.indexOf(operation, cursor + 1);
    expect({ operation, foundAfterPrevious: next > cursor, trace }).toMatchObject({ foundAfterPrevious: true });
    cursor = next;
  }
}

it('survives actual process kill at a durable debugger pause without repeating the physical model request', async () => {
  const conversationId = `process-ordering-${randomUUID()}`;
  const initial = start('pause', conversationId);
  const paused = await initial.report;
  expect(paused).toMatchObject({ kind: 'paused', status: 'paused_debug', pid: initial.child.pid, parentPid: process.pid });
  expect(paused.runId).toBeTruthy();
  expect(paused.attemptId).toBeTruthy();
  expect(paused.instanceId).toMatch(/^[a-f0-9-]{36}$/);
  expect(physicalRequests).toHaveLength(1);
  expect(physicalRequests[0]).toMatchObject({ stream: true });
  expectOrdered(paused.observations, ['archive:dispatch', 'event:model:dispatch', 'archive-outcome:completed',
    'event:recovery:paused', 'snapshot:paused']);
  expect(initial.child.kill('SIGKILL')).toBe(true);
  const killed = await initial.exit;
  expect(killed.signal).toBe('SIGKILL');

  const restarted = start('resume', conversationId);
  const completed = await restarted.report;
  expect(completed).toMatchObject({ kind: 'completed', status: 'completed', pid: restarted.child.pid,
    parentPid: process.pid, runId: paused.runId, attemptId: paused.attemptId, outputText: 'restart fixture answer' });
  expect(completed.instanceId).toMatch(/^[a-f0-9-]{36}$/);
  expect(completed.instanceId).not.toBe(paused.instanceId);
  expect(physicalRequests).toHaveLength(1);
  expect(completed.observations).not.toContain('archive:dispatch');
  expect(completed.observations).not.toContain('event:model:dispatch');
  expectOrdered(completed.observations, ['restart:read-saved-action', 'authority:current',
    'event:recovery:completed', 'snapshot:completed', 'event:run:done']);
  const cleanExit = await restarted.exit;
  expect(cleanExit).toEqual({ code: 0, signal: null });
  console.info('CODE_HEALTH_RESTART_PROCESS_TRACE', JSON.stringify({ conversationId, physicalRequests: physicalRequests.length,
    paused, killed, completed, cleanExit }));
});
