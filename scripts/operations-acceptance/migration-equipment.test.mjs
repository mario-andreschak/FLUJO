import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { withTimeout } from '../mcp-smoke-cleanup.mjs';
import { observeRecoveryWorker, stopRecoveryWorker } from '../worker-recovery-runtime.mjs';

const preload = fileURLToPath(new URL('./migration-fault.cjs', import.meta.url));
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(path|systemroot|windir|comspec|pathext|systemdrive|temp|tmp|localappdata)$/i.test(name)));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-migration-equipment-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const environment = (root, mode) => ({ ...safeEnv, FLUJO_DATA_DIR: root,
  FLUJO_ACCEPTANCE_MIGRATION_ROOT: root, FLUJO_ACCEPTANCE_MIGRATION_FAULT: mode });
const run = (code, env) => spawnSync(process.execPath, ['--require', preload, '-e', code], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });

test('fault equipment refuses a mismatched root and an unknown mode', async t => {
  const root = await fixture(t);
  assert.notEqual(run('process.exit(0)', { ...environment(root, 'enospc-artifacts'), FLUJO_DATA_DIR: root + '-other' }).status, 0);
  assert.notEqual(run('process.exit(0)', environment(root, 'unknown-mode')).status, 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test('ENOSPC equipment retains the actual rename source', async t => {
  const root = await fixture(t), source = path.join(root, 'artifacts'), target = path.join(root, 'workspaces/artifacts');
  await fs.mkdir(source); await fs.mkdir(path.dirname(target)); await fs.writeFile(path.join(source, 'only.txt'), 'only-copy');
  const result = run(`require('node:fs').promises.rename(${JSON.stringify(source)}, ${JSON.stringify(target)}).then(()=>process.exit(2),e=>process.exit(e.code==='ENOSPC'?0:3))`, environment(root, 'enospc-artifacts'));
  assert.equal(result.status, 0); assert.equal(await fs.readFile(path.join(source, 'only.txt'), 'utf8'), 'only-copy');
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
});

test('fault equipment leaves a rename outside its exact root working', async t => {
  const root = await fixture(t), data = path.join(root, 'data'), source = path.join(root, 'outside.txt'), target = path.join(root, 'outside-moved.txt');
  await fs.mkdir(data); await fs.writeFile(source, 'unrelated');
  const result = run(`require('node:fs').promises.rename(${JSON.stringify(source)},${JSON.stringify(target)}).then(()=>process.exit(0),()=>process.exit(1))`, environment(data, 'enospc-artifacts'));
  assert.equal(result.status, 0); assert.equal(await fs.readFile(target, 'utf8'), 'unrelated');
});

test('snapshot equipment observes a real partial write before ENOSPC', async t => {
  const root = await fixture(t), file = path.join(root, 'workspaces/.worker-restore-fixture/userdata/proof.txt');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const result = run(`(async()=>{const h=await require('node:fs').promises.open(${JSON.stringify(file)},'wx');try{const b=Buffer.alloc(8192,42);const first=await h.write(b,0,b.length);if(first.bytesWritten!==4096)throw Error('bad partial');try{await h.write(b,4096,4096);process.exitCode=2}catch(e){process.exitCode=e.code==='ENOSPC'?0:3}}finally{await h.close()}})().catch(()=>process.exitCode=4)`, environment(root, 'enospc-snapshot'));
  assert.equal(result.status, 0); assert.equal((await fs.readFile(file)).length, 4096);
});

test('SIGKILL barrier follows actual directory rename and observes original exit/stdio', async t => {
  const root = await fixture(t), source = path.join(root, 'screenshots'), target = path.join(root, 'workspaces/screenshots');
  await fs.mkdir(source); await fs.mkdir(path.dirname(target)); await fs.writeFile(path.join(source, 'proof.txt'), 'retained');
  const child = spawn(process.execPath, ['--require', preload, '-e', `require('node:fs').promises.rename(${JSON.stringify(source)},${JSON.stringify(target)})`],
    { env: environment(root, 'hold-after-screenshots'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const observed = observeRecoveryWorker(child, 1);
  try {
    const message = await withTimeout(new Promise(resolve => child.once('message', resolve)), 10_000, 'observed rename barrier');
    assert.equal(message.phase, 'screenshots-rename-completed');
    await assert.rejects(fs.lstat(source), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(target, 'proof.txt'), 'utf8'), 'retained');
    await stopRecoveryWorker(observed, { crash: true });
    assert.equal(observed.receipt.signal, 'SIGKILL');
    assert.equal(observed.receipt.parentExitObserved, true); assert.equal(observed.receipt.stdioCloseObserved, true);
  } finally {
    if (!observed.observation.exited || !observed.observation.closed) await stopRecoveryWorker(observed, { crash: true });
  }
});
