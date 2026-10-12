import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

jest.setTimeout(45_000);
const children: ChildProcess[] = [];
let sandbox: string;
beforeEach(async () => { sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-worker-recovery-boundary-')); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  }
  // Allocated by this test, never an operator installation or copied runtime.
  if (!path.basename(sandbox).startsWith('flujo-worker-recovery-boundary-')) throw new Error('Unsafe fixture cleanup');
  await fs.rm(sandbox, { recursive: true, force: true });
});

function start(phase: string, id: string, epoch = '1') {
  const child = spawn(process.execPath, [path.resolve(__dirname, 'fixtures/workerRecoveryProcess.cjs'), phase, id], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_ENV: 'test', FLUJO_DATA_DIR: sandbox, FLUJO_WORKER_MODE: '1',
      FLUJO_WORKER_RECOVERY_ID: 'process-fixture-worker', FLUJO_WORKER_RECOVERY_EPOCH: epoch,
      FLUJO_SNAPSHOT_CONTROL_TOKEN: 'disposable-process-token', FLUJO_WORKER_SNAPSHOT_SHA256: 'a'.repeat(64) },
  });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const lines = readline.createInterface({ input: child.stdout! });
  const first = new Promise<Record<string, unknown>>((resolve, reject) => {
    lines.on('line', line => { try { resolve(JSON.parse(line)); } catch { reject(new Error(`Fixture emitted invalid JSON: ${line}`)); } });
    child.on('error', reject);
    child.on('exit', code => { if (code !== 0) reject(new Error(`Fixture exit ${code}: ${stderr}`)); });
  });
  return { child, first, lines };
}

it('retains an admitted occurrence after actual process kill and fences a changed epoch after restart', async () => {
  const id = randomUUID();
  const original = start('seed-hold', id);
  expect(await original.first).toMatchObject({ ready: true, admitted: 'eligible' });
  const exited = once(original.child, 'exit');
  original.child.kill('SIGKILL'); await exited; original.lines.close();
  const restarted = start('inspect', id);
  expect(await restarted.first).toMatchObject({ reason: 'unresolved-admission', eligible: false,
    pending: { runId: 'original-run-a', occurrenceAt: '2026-10-03T12:00:00.000Z' } });
  if (restarted.child.exitCode === null) await once(restarted.child, 'exit');
  restarted.lines.close();
  const changed = start('inspect', id, '2');
  expect(await changed.first).toMatchObject({ reason: 'worker-authority-changed', eligible: false });
  if (changed.child.exitCode === null) await once(changed.child, 'exit');
  changed.lines.close();
});
