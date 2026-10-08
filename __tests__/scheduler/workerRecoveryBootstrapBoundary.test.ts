import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

// New natural-clock acceptance fixture, independent of the existing 45s ledger
// witness. This deadline includes real minute boundaries and real MCP startup.
jest.setTimeout(420_000);
type Reply = Record<string, any>;
const children: ChildProcess[] = [];
const lifecycle = new WeakMap<ChildProcess, {
  exited: boolean; closed: boolean; stdoutEnded: boolean; stderrEnded: boolean;
  cleanupConfirmed: boolean; cleanupUncertain: boolean; error?: Error;
}>();
let sandbox: string;
let stagingDir: string | undefined;
const additionalStaging: string[] = [];
const directories = require('./fixtures/ownedDirectory.cjs');
const ownedDirectories = new Map<string, { path: string }>();
async function ownDirectory(directory: string, expected?: Record<string, unknown>) {
  ownedDirectories.set(directory, await directories.captureOwnedDirectory(directory, expected));
}

function launch(data: string, env: NodeJS.ProcessEnv, phase?: string) {
  const child = spawn(process.execPath, [path.resolve(__dirname, 'fixtures/workerBootstrapRecovery.cjs'),
    ...(phase ? [phase] : [])], { cwd: process.cwd(), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA,
      TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: 'test',
      FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_DATA_DIR: data, ...env } });
  children.push(child);
  const observed = { exited: false, closed: false, stdoutEnded: false, stderrEnded: false,
    cleanupConfirmed: false, cleanupUncertain: false,
    error: undefined as Error | undefined };
  lifecycle.set(child, observed);
  // Install all lifecycle/error observers immediately, before protocol waits.
  child.on('error', error => { observed.error = error; });
  child.on('exit', () => { observed.exited = true; });
  child.on('close', () => { observed.closed = true; });
  child.stdout!.on('end', () => { observed.stdoutEnded = true; });
  child.stderr!.on('end', () => { observed.stderrEnded = true; });
  child.stdout!.on('error', error => { observed.error = error; });
  child.stderr!.on('error', error => { observed.error = error; });
  const messages: Reply[] = [];
  let diagnostic = '';
  child.stderr!.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-16_384); });
  // Application stdout is deliberately not parsed as a protocol or readiness.
  child.stdout!.resume();
  child.on('message', message => {
    const reply = message as Reply;
    if (reply.phase === 'cleanup-failed') { observed.cleanupUncertain = true; observed.cleanupConfirmed = false; }
    if (reply.phase === 'cleanup-completed') {
      // Only a successful actual backend/owner cleanup attempt emits this.
      observed.cleanupUncertain = false; observed.cleanupConfirmed = true;
    }
    messages.push(reply);
  });
  async function wait(predicate: (reply: Reply) => boolean, timeout = 60_000): Promise<Reply> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (observed.error) throw observed.error;
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
    child.send({ id, action, ...fields }, error => { if (error) observed.error = error; });
    const reply = await wait(message => message.id === id);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  }
  async function exit(timeout = 15_000) {
    const end = Date.now() + timeout;
    while ((!observed.exited || !observed.closed || !observed.stdoutEnded || !observed.stderrEnded)
        && Date.now() < end) {
      if (observed.error) throw observed.error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!observed.exited || !observed.closed || !observed.stdoutEnded || !observed.stderrEnded) {
      throw new Error('Shutdown ACK did not produce observed OS exit, child close and drained stdio');
    }
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
  const incomplete = (child: ChildProcess) => {
    const observed = lifecycle.get(child)!;
    // Failed spawn has no exit event; its error and close are still observed.
    const failedSpawn = observed.error && child.pid === undefined;
    return !observed.closed || (!observed.exited && !failedSpawn)
      || (!observed.stdoutEnded && !(failedSpawn && child.stdout?.destroyed))
      || (!observed.stderrEnded && !(failedSpawn && child.stderr?.destroyed));
  };
  while (children.some(incomplete) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (children.some(incomplete)) {
    throw new Error(`Owned child exit/close/stdio unresolved; preserving fixture at ${sandbox}`);
  }
  if (children.some(child => {
    const observed = lifecycle.get(child)!;
    const failedSpawn = observed.error && child.pid === undefined;
    return !failedSpawn && (observed.error || observed.cleanupUncertain || !observed.cleanupConfirmed);
  })) {
    throw new Error(`Owned cleanup uncertain despite child close; preserving fixture/staging at ${sandbox}`);
  }
  children.length = 0;
  for (const [directory, prefix] of [[sandbox, 'flujo-worker-bootstrap-'], [stagingDir, 'flujo-hot-clone-'],
    ...additionalStaging.map(directory => [directory, 'flujo-hot-clone-'] as const)] as const) {
    if (!directory) continue;
    const token = ownedDirectories.get(directory);
    if (!token) throw new Error(`Owned directory identity unavailable; preserving ${directory}`);
    await directories.removeOwnedDirectory(token, os.tmpdir(), prefix);
    ownedDirectories.delete(directory);
  }
  stagingDir = undefined;
  additionalStaging.length = 0;
});

it('boots real snapshots, recovers a local schedule once, and keeps copied, sibling, paused and disabled schedules inert', async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-worker-bootstrap-'));
  await ownDirectory(sandbox);
  const scratch = path.join(sandbox, 'effects'); await fs.mkdir(scratch);
  const seed = launch(path.join(sandbox, 'seed'), { FLUJO_BOOTSTRAP_EFFECT_ROOT: scratch }, 'seed');
  const snapshot = await seed.wait(message => message.phase === 'seeded');
  stagingDir = snapshot.stagingDir;
  await ownDirectory(snapshot.stagingDir, snapshot.stagingIdentity);
  await seed.exit();
  const workerEnv = { FLUJO_WORKER_MODE: '1', FLUJO_WORKER_SNAPSHOT: snapshot.archivePath,
    FLUJO_WORKER_SNAPSHOT_SHA256: snapshot.sha256, FLUJO_WORKER_SNAPSHOT_KEY: snapshot.key,
    FLUJO_WORKER_RECOVERY_ID: 'owned-bootstrap-worker', FLUJO_WORKER_RECOVERY_EPOCH: '1',
    FLUJO_SNAPSHOT_CONTROL_TOKEN: randomUUID() };
  const data = path.join(sandbox, 'worker');
  let worker = launch(data, workerEnv);
  const boot = await worker.wait(message => message.phase === 'bootstrapped');
  snapshot.journal = boot.journal;
  expect(boot.status.state).toBe('ready');
  expect(boot.plans.find((row: Reply) => row.execution.id === 'copied-plan').status.workerRecovery.eligible).toBe(false);
  const planId = randomUUID();
  await worker.request('create', { planId, flowId: snapshot.flowId });
  await waitEffect(snapshot.journal, 1);
  const firstRun = await waitTerminal(worker, planId);
  await worker.request('start-again'); await worker.request('start-again');
  expect(await effects(snapshot.journal)).toHaveLength(1);
  // Export the genuinely locally enrolled row through the production exporter.
  // Its installation-private HMAC record must not travel to the sibling.
  const localSnapshot = await worker.request('export');
  additionalStaging.push(localSnapshot.stagingDir);
  await ownDirectory(localSnapshot.stagingDir, localSnapshot.stagingIdentity);
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
  const sibling = launch(path.join(sandbox, 'sibling'), { ...workerEnv, FLUJO_WORKER_RECOVERY_ID: 'owned-sibling',
    FLUJO_WORKER_SNAPSHOT: localSnapshot.archivePath, FLUJO_WORKER_SNAPSHOT_SHA256: localSnapshot.sha256,
    FLUJO_WORKER_SNAPSHOT_KEY: localSnapshot.key });
  const siblingBoot = await sibling.wait(message => message.phase === 'bootstrapped');
  expect(siblingBoot.plans.find((row: Reply) => row.execution.id === planId).status.workerRecovery.reason)
    .toBe('no-local-provenance');
  await crossMinute();
  expect(await effects(snapshot.journal)).toHaveLength(2);
  // The exported sibling journal includes the one completed effect at export;
  // no locally enrolled copied row may append another effect in its own tree.
  expect(await effects(siblingBoot.journal)).toHaveLength(1);
  await sibling.request('stop'); await sibling.exit();
});

it.each(['invalid-provenance', 'generation-changed', 'retired', 'not-opted-in'] as const)(
  'keeps a real enrolled worker schedule inert after %s on genuine bootstrap', async reason => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-worker-bootstrap-'));
    await ownDirectory(sandbox);
    const scratch = path.join(sandbox, 'effects'); await fs.mkdir(scratch);
    const seed = launch(path.join(sandbox, 'seed'), { FLUJO_BOOTSTRAP_EFFECT_ROOT: scratch }, 'seed');
    const snapshot = await seed.wait(message => message.phase === 'seeded');
    stagingDir = snapshot.stagingDir;
    await ownDirectory(snapshot.stagingDir, snapshot.stagingIdentity);
    await seed.exit();
    const data = path.join(sandbox, 'worker');
    const env = { FLUJO_WORKER_MODE: '1', FLUJO_WORKER_SNAPSHOT: snapshot.archivePath,
      FLUJO_WORKER_SNAPSHOT_SHA256: snapshot.sha256, FLUJO_WORKER_SNAPSHOT_KEY: snapshot.key,
      FLUJO_WORKER_RECOVERY_ID: 'owned-negative-worker', FLUJO_WORKER_RECOVERY_EPOCH: '1',
      FLUJO_SNAPSHOT_CONTROL_TOKEN: randomUUID() };
    let worker = launch(data, env);
    const boot = await worker.wait(message => message.phase === 'bootstrapped');
    snapshot.journal = boot.journal;
    // Pause before creation/enrollment so setup cannot itself schedule an effect.
    await worker.request('pause', { paused: true });
    const planId = randomUUID();
    await worker.request('create', { planId, flowId: snapshot.flowId });
    if (reason === 'not-opted-in') await worker.request('withdraw', { planId });
    await worker.request('stop'); await worker.exit();
    // Negative controls deliberately alter only owned offline fixture objects.
    // Neither provenance nor a generation is forged to grant admission.
    const planFile = path.join(boot.workspaceDataDir, 'db', 'planned_executions.json');
    const stored = JSON.parse(await fs.readFile(planFile, 'utf8'));
    stored.paused = false;
    const plan = stored.executions.find((row: Reply) => row.id === planId);
    if (reason === 'generation-changed') plan.generationId = randomUUID();
    if (reason === 'retired') plan.personaRetired = true;
    await fs.writeFile(planFile, JSON.stringify(stored));
    if (reason === 'invalid-provenance') {
      const key = createHash('sha256').update(`${snapshot.workspace}\0${planId}`).digest('hex');
      const recordFile = path.join(data, '.worker-local-recovery', snapshot.workspace, `${key}.json`);
      const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
      record.signature = '0'.repeat(64);
      await fs.writeFile(recordFile, JSON.stringify(record));
    }
    worker = launch(data, env);
    const rejected = await worker.wait(message => message.phase === 'bootstrapped');
    const status = rejected.plans.find((row: Reply) => row.execution.id === planId).status;
    expect(status.workerRecovery.reason).toBe(reason);
    expect(status.armed).toBe(false);
    await crossMinute();
    expect(await effects(snapshot.journal)).toHaveLength(0);
    await worker.request('stop'); await worker.exit();
  });
