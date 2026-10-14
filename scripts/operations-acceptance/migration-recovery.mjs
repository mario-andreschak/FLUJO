// Run through flujo-bash: all disposable fixture cleanup follows AGENTS.md.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { verifyBuildEvidence } from './build-evidence.mjs';
import { createSmokeOperator } from '../smoke-bundled-operator.mjs';
import { createPrivateSmokeProfile } from '../smoke-cloud-worker-profile.mjs';
import { copiedRecoveryPlan, boundedJson } from '../worker-recovery-acceptance.mjs';
import { withTimeout } from '../mcp-smoke-cleanup.mjs';
import { inspectRecoveryApplication, observeRecoveryWorker, recoveryBudget, stopRecoveryWorker } from '../worker-recovery-runtime.mjs';

const args = process.argv.slice(2);
assert.ok((args.length === 4 || args.length === 6 && args[4] === '--fail-at' && args[5] === 'first-restart')
  && args[0] === '--report' && args[2] === '--build-evidence' && path.isAbsolute(args[1]) && path.isAbsolute(args[3]),
'Usage: migration-recovery.mjs --report <new-absolute-report> --build-evidence <absolute-receipt> [--fail-at first-restart]');
const report = path.resolve(args[1]);
await assert.rejects(fs.access(report), { code: 'ENOENT' });
await assert.rejects(fs.access(report + '.log'), { code: 'ENOENT' });
const application = fileURLToPath(new URL('../../', import.meta.url));
const build = await verifyBuildEvidence(application, args[3]);
const operator = await createSmokeOperator();
const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
const budget = recoveryBudget();
const generations = [], checks = [];
const password = randomBytes(32).toString('base64url'), controlToken = randomBytes(32).toString('base64url');
const archiveKey = randomBytes(32), secrets = [operator.token, password, controlToken, archiveKey.toString('base64')];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let current, base, currentEnv, failure, cleanupVerified = false, timer, serverLog = '';
const check = name => { checks.push({ name, generation: generations.length, observedUtc: new Date().toISOString() }); console.log(`Passed: ${name}`); };
const write = async (file, content) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, { mode: 0o600 }); };
const exists = async file => Boolean(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }));
async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function request(endpoint, expected, { body, worker = false } = {}) {
  budget.assertOpen();
  const response = await fetch(base + endpoint, { redirect: 'error',
    signal: AbortSignal.any([budget.signal, AbortSignal.timeout(10_000)]),
    headers: { authorization: `Bearer ${worker ? controlToken : operator.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  assert.equal(response.status, expected, `Unexpected HTTP status at ${endpoint}`);
  return boundedJson(response);
}
async function health(expected) {
  const child = spawn(process.execPath, [path.join(application, 'scripts/healthcheck.mjs')], {
    cwd: application, env: { ...currentEnv, FLUJO_HEALTHCHECK_TOKEN: operator.token },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const observed = observeRecoveryWorker(child, `health-${generations.length}`);
  let bytes = 0;
  child.stdout.on('data', data => { bytes += data.length; }); child.stderr.on('data', data => { bytes += data.length; });
  try {
    await withTimeout(observed.observation.exit, 10_000, 'owned actual health CLI exit');
    await withTimeout(observed.observation.close, 5_000, 'owned health CLI stdio close');
    assert.equal(observed.receipt.exitCode, expected ? 0 : 1);
    assert.equal(bytes, 0, 'The health CLI must stay silent.');
  } finally {
    if (!observed.observation.exited || !observed.observation.closed) {
      await stopRecoveryWorker(observed, { crash: true });
    }
  }
}
async function stop(crash = false) {
  if (!current) return;
  await stopRecoveryWorker(current, { crash });
  assert.equal(current.receipt.parentExitObserved, true); assert.equal(current.receipt.stdioCloseObserved, true);
  if (crash) assert.equal(current.receipt.signal, 'SIGKILL');
  current = undefined;
}
async function start(data, { fault, worker = false, archive, digest, waitForFault } = {}) {
  budget.assertOpen(); assert.ok(generations.length < 6, 'Unexpected additional application generation.');
  const port = await unusedPort(); base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(name)));
  Object.assign(env, operator.env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'home/roaming'),
    LOCALAPPDATA: path.join(root, 'home/local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), TMPDIR: path.join(root, 'temp'),
    FLUJO_APP_ROOT: application, FLUJO_DATA_DIR: data, FLUJO_RUNTIME_ENV_DIR: application,
    FLUJO_ENCRYPTION_SECRET_FILE: path.join(root, 'operator-secret'),
    FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_BASE_URL: base, FLUJO_PORT: String(port), FLUJO_BUILD_REVISION: build.sourceRevision,
    FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(await unusedPort()),
    FLUJO_ACCEPTANCE_MIGRATION_ROOT: data, ...(fault ? { FLUJO_ACCEPTANCE_MIGRATION_FAULT: fault } : {}) });
  if (worker) Object.assign(env, { FLUJO_WORKER_MODE: '1', FLUJO_WORKER_SNAPSHOT: archive,
    FLUJO_WORKER_SNAPSHOT_SHA256: digest, FLUJO_WORKER_SNAPSHOT_KEY: archiveKey.toString('base64'), FLUJO_SNAPSHOT_CONTROL_TOKEN: controlToken });
  await inspectRecoveryApplication(application, env);
  let readyResolve, faultResolve, rejectAdmission;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const faultObserved = new Promise(resolve => { faultResolve = resolve; });
  const admissionFailure = new Promise((resolve, reject) => { rejectAdmission = reject; });
  const child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
    cwd: application, env, execPath: process.execPath, execArgv: ['--require', path.join(application, 'scripts/operations-acceptance/migration-fault.cjs')],
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  current = observeRecoveryWorker(child, generations.length + 1); currentEnv = env;
  current.receipt.profile = worker ? 'source-encrypted-snapshot-worker' : 'source-owner-migration';
  current.receipt.injectedFault = fault ?? null; current.receipt.faultObservations = [];
  generations.push(current); const owned = current;
  child.on('message', message => {
    try {
    if (message?.type === 'journey-server-ready' && message.pid === child.pid) readyResolve();
    if (message?.type === 'migration-fault-observed') {
      assert.ok(owned.receipt.faultObservations.length < 32, 'Fault observation budget exceeded.');
      owned.receipt.faultObservations.push({ phase: message.phase, bytesWritten: message.bytesWritten, observedUtc: new Date().toISOString() });
      if (!waitForFault || message.phase === waitForFault) faultResolve();
    }
    } catch (error) { budget.refuse(error); rejectAdmission(error); }
  });
  const output = bytes => { try { budget.chargeOutput(bytes.length); serverLog = (serverLog + bytes).slice(-2 * 1024 * 1024); }
    catch { owned.observation.child.kill('SIGKILL'); } };
  child.stdout.on('data', output); child.stderr.on('data', output);
  const selected = waitForFault ? faultObserved : ready;
  await withTimeout(Promise.race([selected, admissionFailure, owned.observation.exit.then(() => { throw new Error('Owned application exited before admission.'); })]), 60_000, 'actual application admission');
  if (fault && !waitForFault) await withTimeout(faultObserved, 30_000, 'actual injected operation');
  return owned;
}
async function ready(worker = false) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    budget.assertOpen(); assert.equal(current.observation.exited, false);
    const response = await fetch(base + (worker ? '/api/worker/status' : '/api/workspaces'), {
      headers: { authorization: `Bearer ${worker ? controlToken : operator.token}` }, signal: AbortSignal.timeout(5_000) });
    const body = await boundedJson(response);
    if (response.status === 200 && (!worker || body.state === 'ready')) return body;
    if (body.code === 'WORKSPACE_LAYOUT_UNAVAILABLE' || worker && body.state === 'error') throw new Error('Application layout remained failed after restart.');
    if (Date.now() >= deadline) throw new Error('Application did not recover readiness.');
    await delay(250);
  }
}
try {
  timer = setTimeout(() => { budget.refuse(new Error('Whole recovery acceptance deadline exceeded.'));
    if (current && !current.observation.exited) current.observation.child.kill('SIGKILL'); }, budget.remainingMs());
  for (const directory of ['home', 'home/local', 'home/roaming', 'temp']) await fs.mkdir(path.join(root, directory), { recursive: true });
  await write(path.join(root, 'operator-secret'), randomBytes(32).toString('base64url'));
  const data = path.join(root, 'data'), workspace = path.join(data, 'workspaces/default-workspace');
  const profile = await createPrivateSmokeProfile(password);
  await write(path.join(data, 'db/encryption_key.json'), JSON.stringify(profile.metadata));
  await write(path.join(data, 'db/mcp_servers.json'), '{}');
  const payload = Buffer.from('migration-payload-retained\n'.repeat(2048)), payloadHash = hash(payload);
  await write(path.join(data, 'userdata/packages/shared/payload.txt'), payload);
  const originalLink = path.join(data, 'artifacts/dependency'); await fs.mkdir(path.dirname(originalLink), { recursive: true });
  await fs.symlink(path.join(data, 'userdata/packages/shared'), originalLink, process.platform === 'win32' ? 'junction' : 'dir');
  await start(data, { fault: 'enospc-artifacts' });
  await request('/api/workspaces', 503); await request('/api/cwd', 503); await health(false);
  assert.equal(hash(await fs.readFile(path.join(workspace, 'userdata/packages/shared/payload.txt'))), payloadHash);
  assert.equal(await exists(originalLink), true); assert.equal(await exists(path.join(data, 'userdata')), false);
  assert.equal(await exists(path.join(data, 'workspaces/.workspace-layout.links.json')), true);
  assert.equal(await exists(path.join(data, 'workspaces/.workspace-layout.json')), false);
  check('ENOSPC after partial migration retains data/link receipt and refuses authenticated readiness');
  await stop();
  await start(data); await ready();
  await request('/api/encryption/secure', 200, { body: { action: 'authenticate', password } }); await health(true);
  assert.equal((await fs.realpath(path.join(workspace, 'artifacts/dependency'))).toLowerCase(),
    (await fs.realpath(path.join(workspace, 'userdata/packages/shared'))).toLowerCase());
  assert.equal(hash(await fs.readFile(path.join(workspace, 'artifacts/dependency/payload.txt'))), payloadHash);
  assert.equal(await exists(path.join(data, 'workspaces/.workspace-layout.links.json')), false);
  check('Same-root restart reuses recorded Windows junction kind and recovers original payload');
  if (args[5] === 'first-restart') throw new Error('Witnessed first-restart acceptance failure');
  await stop();
  await write(path.join(data, 'screenshots/packages/shared/payload.txt'), payload);
  const screenshotLink = path.join(data, 'screenshots/dependency');
  await fs.symlink(path.join(data, 'screenshots/packages/shared'), screenshotLink, process.platform === 'win32' ? 'junction' : 'dir');
  await start(data, { fault: 'hold-after-screenshots', waitForFault: 'screenshots-rename-completed' });
  assert.equal(await exists(path.join(data, 'screenshots')), false);
  assert.equal(await exists(path.join(data, 'workspaces/.workspace-layout.links.json')), true);
  await stop(true); check('Original child SIGKILL follows observed directory rename before link remap');
  await start(data); await ready();
  await request('/api/encryption/secure', 200, { body: { action: 'authenticate', password } }); await health(true);
  assert.equal(hash(await fs.readFile(path.join(workspace, 'screenshots/dependency/payload.txt'))), payloadHash);
  assert.equal(await exists(path.join(data, 'workspaces/.workspace-layout.links.json')), false);
  check('Restart repairs remap receipt after source folder disappeared and preserves payload hash');
  await stop();
  const workerData = path.join(root, 'worker-data'), workerWorkspace = 'migration-restore-fixture';
  const workerProfile = await createPrivateSmokeProfile(), pkg = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'));
  const proof = Buffer.from('snapshot-disaster-payload\n'.repeat(8192)), proofHash = hash(proof);
  const files = { 'db/encryption_key.json': JSON.stringify(workerProfile.metadata),
    'db/worker-bootstrap-secrets.json': JSON.stringify(workerProfile.bootstrap), 'db/mcp_servers.json': '{}',
    'db/planned_executions.json': JSON.stringify({ version: 1, paused: false, executions: [copiedRecoveryPlan('copied-fixture-flow')] }),
    'userdata/proof.txt': proof };
  const zip = new JSZip(); for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
  zip.file('snapshot-manifest.json', JSON.stringify({ formatVersion: 2, layoutVersion: 2, workspace: workerWorkspace,
    externalRootsIncluded: false, source: { version: pkg.version, platform: process.platform },
    subtrees: ['db', 'mcp-servers', 'userdata', 'snapshots', 'screenshots', 'recordings', 'browser-profile', 'bash-utils', 'artifacts'],
    files: Object.entries(files).map(([name, bytes]) => ({ path: name, size: Buffer.byteLength(bytes), sha256: hash(bytes) })),
    runtime: { codexAuth: 'none', encryption: 'user', mcpTransfer: { formatVersion: 1, sourceWorkspaceRoot: 'C:\\synthetic-source\\workspaces\\migration-restore-fixture', servers: [] } } }));
  const plaintext = await zip.generateAsync({ type: 'nodebuffer' }), digest = hash(plaintext), archive = path.join(root, 'worker.snapshot');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', archiveKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  await write(archive, JSON.stringify({ format: 'flujo-workspace-encrypted', version: 1, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') }));
  const archiveHash = hash(await fs.readFile(archive));
  const failedWorker = await start(workerData, { worker: true, fault: 'enospc-snapshot', archive, digest });
  const status = await request('/api/worker/status', 503, { worker: true }); assert.equal(status.state, 'error');
  await health(false);
  assert.ok(failedWorker.receipt.faultObservations.some(row => row.phase === 'snapshot-partial-write' && row.bytesWritten > 0));
  assert.equal(await exists(path.join(workerData, 'workspaces', workerWorkspace)), false);
  assert.equal((await fs.readdir(path.join(workerData, 'workspaces'))).some(name => name.startsWith('.worker-restore-')), false);
  assert.equal(hash(await fs.readFile(archive)), archiveHash);
  check('Encrypted snapshot ENOSPC after actual partial write publishes no workspace and retains archive');
  await stop();
  await start(workerData, { worker: true, archive, digest }); const workerStatus = await ready(true); await health(true);
  assert.equal(workerStatus.workspace, workerWorkspace); assert.deepEqual(workerStatus.servers, []);
  assert.equal(hash(await fs.readFile(path.join(workerData, 'workspaces', workerWorkspace, 'userdata/proof.txt'))), proofHash);
  assert.equal(hash(await fs.readFile(archive)), archiveHash);
  check('Same archive restarts into ready encrypted worker with independently matched restored bytes');
  await stop();
} catch (error) { failure = error; }
finally {
  clearTimeout(timer);
  try { await stop(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
  try {
    assert.ok(generations.every(row => row.receipt.parentExitObserved && row.receipt.stdioCloseObserved && !row.receipt.abandoned),
      'All owned original processes must exit and close before private fixture cleanup.');
    await operator.restore(); assert.equal(await exists(root), false); cleanupVerified = true;
  } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
  for (const secret of secrets) serverLog = serverLog.split(secret).join('[redacted]');
  const receipt = { schemaVersion: 1, outcome: failure ? 'failed' : 'passed', completedUtc: new Date().toISOString(),
    node: process.version, platform: process.platform, sourceRevision: build.sourceRevision, buildId: build.buildId,
    sourceInputs: build.sourceInputs, builtInputs: build.builtInputs, checks, generations: generations.map(row => row.receipt),
    cleanup: { privateRoot: root, verifiedAbsent: cleanupVerified }, window: budget.receipt(),
    equipment: Object.fromEntries(await Promise.all(['migration-recovery.mjs', 'migration-fault.cjs'].map(async name => [name, hash(await fs.readFile(new URL(name, import.meta.url)))]))),
    limits: ['Actual source-built Windows/Node profile; no installed/container/release qualification.',
      'ENOSPC injected into actual Node filesystem calls; no physical disk exhaustion.',
      'Encrypted snapshot fork recovery; no complete installation/authority disaster-restore qualification.',
      'No provider, bundled MCP, non-author operator or external-effect acceptance.'] };
  await fs.writeFile(report + '.log', serverLog, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(report, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ outcome: receipt.outcome, checks: checks.length, generations: generations.length, cleanupVerified, report }));
  if (failure) { console.error('Migration recovery acceptance failed; inspect the private receipt/log.'); process.exitCode = 1; }
}
