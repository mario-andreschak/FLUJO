import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// New natural-clock acceptance fixture, independent of the existing 45s ledger
// witness. This deadline includes real minute boundaries and real MCP startup.
jest.setTimeout(420_000);
type Reply = Record<string, any>;
const children: ChildProcess[] = [];
let sandbox: string;
let stagingDir: string | undefined;

function launch(data: string, env: NodeJS.ProcessEnv, phase?: string) {
  const child = spawn(process.execPath, [path.resolve(__dirname, 'fixtures/workerBootstrapRecovery.cjs'),
    ...(phase ? [phase] : [])], { cwd: process.cwd(), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA,
      TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: 'test',
      FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_DATA_DIR: data, ...env } });
  children.push(child);
  const messages: Reply[] = [];
  let diagnostic = '';
  child.stderr!.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-16_384); });
  // Application stdout is deliberately not parsed as a protocol or readiness.
  child.stdout!.resume();
  child.on('message', message => messages.push(message as Reply));
  async function wait(predicate: (reply: Reply) => boolean, timeout = 60_000): Promise<Reply> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const failed = messages.find(reply => reply.phase === 'failed' || reply.phase === 'cleanup-failed');
      if (failed) throw new Error(failed.error);
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Premature child exit: ${diagnostic}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Worker witness timed out: ${diagnostic}`);
  }
  async function request(action: string, fields: Reply = {}) {
    const id = randomUUID();
    child.send({ id, action, ...fields });
    const reply = await wait(message => message.id === id);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  }
  async function exit(timeout = 15_000) {
    const end = Date.now() + timeout;
    while (child.exitCode === null && child.signalCode === null && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (child.exitCode === null && child.signalCode === null) throw new Error('Shutdown ACK did not produce OS exit');
    expect(child.exitCode).toBe(0);
  }
  return { child, wait, request, exit };
}

async function effects(journal: string) {
  try { return (await fs.readFile(journal, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function waitEffect(journal: string, count: number) {
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    const observed = await effects(journal);
    if (observed.length >= count) { expect(observed).toHaveLength(count); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Actual scheduled Bash effect was not observed');
}
async function crossMinute() {
  const delay = 60_000 - Date.now() % 60_000 + 2_000;
  await new Promise(resolve => setTimeout(resolve, delay));
}
async function waitTerminal(worker: ReturnType<typeof launch>, planId: string, priorRunId?: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await worker.request('list');
    const row = rows.find((candidate: Reply) => candidate.execution.id === planId);
    if (row?.lastRun?.runId !== priorRunId && row?.lastRun?.finishedAt
        && !row.status.workerRecovery.pending) {
      expect(row.lastRun.status).toBe('completed');
      return row.lastRun.runId as string;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Effect occurred without observed genuine terminal recovery publication');
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null && child.connected) child.disconnect();
  }
  const end = Date.now() + 15_000;
  while (children.some(child => child.exitCode === null && child.signalCode === null) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (children.some(child => child.exitCode === null && child.signalCode === null)) {
    throw new Error(`Owned child still live; preserving fixture at ${sandbox}`);
  }
  children.length = 0;
  for (const [directory, prefix] of [[sandbox, 'flujo-worker-bootstrap-'], [stagingDir, 'flujo-hot-clone-']] as const) {
    if (!directory) continue;
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)
        || (await fs.lstat(resolved)).isSymbolicLink()) throw new Error('Unsafe bootstrap fixture cleanup');
    await fs.rm(resolved, { recursive: true, force: true });
  }
  stagingDir = undefined;
});

it('boots real snapshots, recovers a local schedule once, and keeps copied, sibling, paused and disabled schedules inert', async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-worker-bootstrap-'));
  const scratch = path.join(sandbox, 'effects'); await fs.mkdir(scratch);
  const seed = launch(path.join(sandbox, 'seed'), { FLUJO_BOOTSTRAP_EFFECT_ROOT: scratch }, 'seed');
  const snapshot = await seed.wait(message => message.phase === 'seeded');
  stagingDir = snapshot.stagingDir;
  await seed.exit();
  const workerEnv = { FLUJO_WORKER_MODE: '1', FLUJO_WORKER_SNAPSHOT: snapshot.archivePath,
    FLUJO_WORKER_SNAPSHOT_SHA256: snapshot.sha256, FLUJO_WORKER_SNAPSHOT_KEY: snapshot.key,
    FLUJO_WORKER_RECOVERY_ID: 'owned-bootstrap-worker', FLUJO_WORKER_RECOVERY_EPOCH: '1',
    FLUJO_SNAPSHOT_CONTROL_TOKEN: randomUUID() };
  const data = path.join(sandbox, 'worker');
  let worker = launch(data, workerEnv);
  const boot = await worker.wait(message => message.phase === 'bootstrapped');
  expect(boot.status.state).toBe('ready');
  expect(boot.plans.find((row: Reply) => row.execution.id === 'copied-plan').status.workerRecovery.eligible).toBe(false);
  const planId = randomUUID();
  await worker.request('create', { planId, flowId: snapshot.flowId });
  await waitEffect(snapshot.journal, 1);
  const firstRun = await waitTerminal(worker, planId);
  await worker.request('start-again'); await worker.request('start-again');
  expect(await effects(snapshot.journal)).toHaveLength(1);
  await worker.request('stop'); await worker.exit();
  // A naturally missed occurrence must be recovered by bootstrap, not runNow.
  await crossMinute();
  worker = launch(data, workerEnv);
  await worker.wait(message => message.phase === 'bootstrapped');
  await waitEffect(snapshot.journal, 2);
  await waitTerminal(worker, planId, firstRun);
  await worker.request('pause', { paused: true });
  await worker.request('stop'); await worker.exit();
  await crossMinute();
  worker = launch(data, workerEnv);
  const pausedBoot = await worker.wait(message => message.phase === 'bootstrapped');
  expect(pausedBoot.plans.find((row: Reply) => row.execution.id === planId).status.workerRecovery.reason).toBe('paused');
  expect(await effects(snapshot.journal)).toHaveLength(2);
  await worker.request('disable', { planId });
  await worker.request('pause', { paused: false });
  await worker.request('stop'); await worker.exit();
  worker = launch(data, workerEnv);
  const disabledBoot = await worker.wait(message => message.phase === 'bootstrapped');
  expect(disabledBoot.plans.find((row: Reply) => row.execution.id === planId).status.workerRecovery.reason).toBe('disabled');
  await crossMinute();
  expect(await effects(snapshot.journal)).toHaveLength(2);
  await worker.request('stop'); await worker.exit();
  const sibling = launch(path.join(sandbox, 'sibling'), { ...workerEnv, FLUJO_WORKER_RECOVERY_ID: 'owned-sibling' });
  await sibling.wait(message => message.phase === 'bootstrapped');
  await crossMinute();
  expect(await effects(snapshot.journal)).toHaveLength(2);
  await sibling.request('stop'); await sibling.exit();
});
