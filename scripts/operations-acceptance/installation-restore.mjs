// Invoke through flujo-bash: the entire disposable installation is owned equipment.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { verifyBuildEvidence } from './build-evidence.mjs';
import { createSmokeOperator } from '../smoke-bundled-operator.mjs';
import { boundedJson } from '../worker-recovery-acceptance.mjs';
import { withTimeout } from '../mcp-smoke-cleanup.mjs';
import { checkHealth } from '../healthcheck.mjs';
import { inspectRecoveryApplication, observeRecoveryWorker, recoveryBudget, stopRecoveryWorker } from '../worker-recovery-runtime.mjs';

const args = process.argv.slice(2);
assert.ok((args.length === 4 || args.length === 6 && args[4] === '--fail-at' && args[5] === 'captured')
  && args[0] === '--report' && args[2] === '--build-evidence' && path.isAbsolute(args[1]) && path.isAbsolute(args[3]),
'Usage: installation-restore.mjs --report <new-absolute-report> --build-evidence <absolute-receipt> [--fail-at captured]');
const report = path.resolve(args[1]);
await assert.rejects(fs.access(report), { code: 'ENOENT' });
await assert.rejects(fs.access(report + '.log'), { code: 'ENOENT' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const application = fileURLToPath(new URL('../../', import.meta.url));
const build = await verifyBuildEvidence(application, args[3]);
const equipment = Object.fromEntries(await Promise.all(['installation-restore.mjs', 'build-evidence.mjs'].map(async name =>
  [name, hash(await fs.readFile(new URL(name, import.meta.url)))])));
const operator = await createSmokeOperator();
const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE), privateIdentity = await fs.realpath(root);
const data = path.join(root, 'data'), workspace = 'default-workspace';
const workspaceRoot = path.join(data, 'workspaces', workspace);
const mount = path.join(root, 'encryption-secret');
const budget = recoveryBudget({ totalMs: 300_000 });
const generations = [], checks = [], requests = [];
const archiveKey = randomBytes(32), protectionSecret = randomBytes(32).toString('base64url');
const providerKey = randomBytes(32).toString('base64url');
const secrets = [operator.token, protectionSecret, providerKey, archiveKey.toString('base64')];
const startedAt = new Date().toISOString();
let current, base, mode = 'failure', failure, cleanupVerified = false, providerClosed = false, serverLog = '', timer;
let baseline, archiveDigest, snapshotDigest, liveCookie, revokedCookie, execution, failedRun;
const check = name => { checks.push({ name, generation: generations.length, observedUtc: new Date().toISOString() }); console.log(`Passed: ${name}`); };
const write = async (file, bytes) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); };
const exists = async file => Boolean(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }));
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function unusedPort() { const probe = http.createServer(), port = await listen(probe); await new Promise(resolve => probe.close(resolve)); return port; }
const provider = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${providerKey}`, 'Restored credential must reach the provider correctly.');
    let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 128 * 1024); }
    const input = JSON.parse(body);
    assert.ok(requests.length < 8, 'Unexpected automatic retry/replay.');
    const row = { sequence: requests.length + 1, mode, generation: generations.length, receivedAt: new Date().toISOString(), credentialMatched: true };
    requests.push(row);
    await fs.appendFile(path.join(root, 'provider-effects.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
    if (mode === 'failure') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic restore fixture bad request.', type: 'invalid_request_error', code: 'bad_request' } })); return;
    }
    const info = { id: `restore-fixture-${row.sequence}`, model: input.model, created: Math.floor(Date.now() / 1000) };
    if (input.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Restored fixture completed.' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...info, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Restored fixture completed.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }));
    }
  } catch { budget.refuse(new Error('Fixture provider received an inadmissible request.')); response.writeHead(500); response.end(); }
});
async function api(endpoint, { body, method = body === undefined ? 'GET' : 'POST', status = 200, bearer = operator.token, cookie, raw = false } = {}) {
  budget.assertOpen();
  const url = new URL(endpoint, base); url.searchParams.set('workspace', workspace);
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.any([budget.signal, AbortSignal.timeout(30_000)]),
    headers: { origin: base, 'sec-fetch-site': 'same-origin', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, status, `${method} ${endpoint} returned an unexpected status.`);
  return raw ? response : boundedJson(response);
}
async function stop() {
  if (!current) return;
  await stopRecoveryWorker(current); assert.equal(current.receipt.parentExitObserved, true); assert.equal(current.receipt.stdioCloseObserved, true);
  current = undefined;
}
async function start(profile) {
  budget.assertOpen(); assert.ok(!current && generations.length < 5);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(name)));
  Object.assign(env, operator.env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'home/roaming'),
    LOCALAPPDATA: path.join(root, 'home/local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), TMPDIR: path.join(root, 'temp'),
    FLUJO_APP_ROOT: application, FLUJO_DATA_DIR: data, FLUJO_RUNTIME_ENV_DIR: application,
    FLUJO_ENCRYPTION_SECRET_FILE: mount, FLUJO_OWNER_BROWSER_ORIGIN: base,
    FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_BASE_URL: base, FLUJO_PORT: new URL(base).port, FLUJO_BUILD_REVISION: build.sourceRevision,
    FLUJO_LOCAL_INSTANCE_DIR: path.join(root, 'local-instances'),
    FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(await unusedPort()) });
  await inspectRecoveryApplication(application, env);
  const child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [new URL(base).port], {
    cwd: application, env, execPath: process.execPath, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  current = observeRecoveryWorker(child, generations.length + 1); current.receipt.profile = profile; generations.push(current);
  const owned = current;
  const ready = new Promise((resolve, reject) => { child.on('message', message => {
    if (message?.type === 'journey-server-ready' && message.pid === child.pid) resolve();
  }); child.once('error', reject); owned.observation.exit.then(() => reject(new Error('Application exited before admission.'))); });
  const output = bytes => { try { budget.chargeOutput(bytes.length); serverLog = (serverLog + bytes).slice(-2 * 1024 * 1024); } catch { child.kill('SIGKILL'); } };
  child.stdout.on('data', output); child.stderr.on('data', output);
  await withTimeout(ready, 60_000, 'actual source application admission');
}
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.ok(!entry.isSymbolicLink(), 'This regular-file source fixture does not qualify linked backup.');
    const file = path.join(directory, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await inventory(file, name + '/'));
    else { const stat = await fs.lstat(file); assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 4 * 1024 * 1024);
      const bytes = await fs.readFile(file); files.push({ name, bytes, size: bytes.length, sha256: hash(bytes) }); }
  }
  return files;
}
const publicInventory = files => files.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
function seal(bytes) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', archiveKey, iv);
  cipher.setAAD(Buffer.from('flujo-installation-restore-fixture-v1'));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64') }));
}
function open(bytes, expectedDigest, key = archiveKey) {
  assert.equal(hash(bytes), expectedDigest, 'Backup digest mismatch; do not stage or publish.');
  const envelope = JSON.parse(bytes), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from('flujo-installation-restore-fixture-v1')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
}
async function stage(bytes, directory, failAfter) {
  const zip = await JSZip.loadAsync(bytes), manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.deepEqual(manifest, baseline); let written = 0;
  const members = Object.values(zip.files).filter(entry => !entry.dir && entry.name !== 'manifest.json').map(entry => entry.name).sort();
  assert.deepEqual(members, baseline.map(entry => entry.name).sort());
  for (const entry of baseline) {
    assert.match(entry.name, /^(data|external)\/[A-Za-z0-9_.\/-]+$/); assert.ok(!entry.name.split('/').includes('..'));
    const content = await zip.file(entry.name).async('nodebuffer'); assert.equal(content.length, entry.size); assert.equal(hash(content), entry.sha256);
    await write(path.join(directory, entry.name), content);
    if (++written === failAfter) throw new Error('Witnessed staging interruption before publication.');
  }
  assert.deepEqual(publicInventory(await inventory(directory)), baseline);
}
async function sample() {
  const value = await api('/api/operations/status'); assert.equal(value.complete, true); assert.equal(value.workspace, workspace);
  assert.equal(value.scheduler.pausedInStoredConfig, true); assert.equal(value.scheduler.armedTriggers, 0);
  assert.equal(value.scheduler.runningRuns, 0); assert.deepEqual(value.processes, []);
  assert.ok(!JSON.stringify(value).includes(providerKey)); return value;
}
async function health(expected) {
  budget.assertOpen();
  assert.equal(await checkHealth({ env: { FLUJO_PORT: new URL(base).port, FLUJO_HEALTHCHECK_TOKEN: operator.token } }), expected);
}
try {
  timer = setTimeout(() => { budget.refuse(new Error('Installation restore whole-window deadline exceeded.'));
    if (current && !current.observation.exited) current.observation.child.kill('SIGKILL'); }, budget.remainingMs());
  for (const directory of ['home', 'home/local', 'home/roaming', 'temp']) await fs.mkdir(path.join(root, directory), { recursive: true });
  await write(mount, protectionSecret);
  // Keep the normal shipped-name provisioning path while explicitly disabling
  // every fixture App. Disabled user records survive startup migration.
  const disabledApps = Object.fromEntries(['flujo', 'filesystem', 'bash', 'browser'].map(name => [name, {
    transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'],
    rootPath: `mcp-servers/${name}`, env: {}, disabled: true,
  }]));
  await write(path.join(workspaceRoot, 'db/mcp_servers.json'), JSON.stringify(disabledApps));
  await write(path.join(workspaceRoot, 'db/planned_executions.json'), JSON.stringify({ version: 1, paused: true, executions: [] }));
  await write(path.join(data, 'workspaces/second-fixture/db/mcp_servers.json'), JSON.stringify(disabledApps));
  await write(path.join(data, 'workspaces/second-fixture/db/planned_executions.json'), JSON.stringify({ version: 1, paused: true, executions: [] }));
  await write(path.join(data, 'workspaces/second-fixture/userdata/proof.bin'), randomBytes(4096));
  await write(path.join(data, '.installation-private-proof'), randomBytes(32));
  const providerPort = await listen(provider); base = `http://127.0.0.1:${await unusedPort()}`;
  await start('original-operator-installation');
  assert.equal((await api('/api/encryption/secure', { body: { action: 'initialize_default' } })).success, true);
  await health(true);
  const metadataFile = path.join(workspaceRoot, 'db/encryption_key.json');
  const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8')); assert.equal(metadata.key_protection, 'operator-file');
  await api('/api/model', { status: 201, body: { id: 'installation-fixture-model', name: 'installation-fixture-model',
    provider: 'openai', adapter: 'openai', ApiKey: providerKey, baseUrl: `http://127.0.0.1:${providerPort}/v1` } });
  const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: type, properties } });
  const nodes = [node('start', 'start'), node('process', 'process', { boundModel: 'installation-fixture-model',
    promptTemplate: 'Reply to the user.', inputMode: 'full-history', allowQuestion: false }), node('finish', 'finish')];
  const edge = (a, b) => ({ id: `${a.id}->${b.id}`, source: a.id, target: b.id,
    sourceHandle: `${a.type}-bottom`, targetHandle: `${b.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
  await api('/api/flow', { status: 201, body: { id: 'installation-fixture-flow', name: 'Installation fixture flow', nodes,
    edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])], updatedAt: Date.now() } });
  execution = (await api('/api/planned-executions', { status: 201, body: { name: 'Installation fixture retained failure', enabled: true,
    flowId: 'installation-fixture-flow', prompt: 'Synthetic installation recovery.', saveConversations: true, approvalPolicy: 'pause',
    overlapStrategy: 'skip', startRestriction: 'singleton', trigger: { type: 'schedule', cron: '*/1 * * * * *', catchUp: true } } })).execution;
  failedRun = (await api(`/api/planned-executions/${execution.id}/run`, { body: {} })).record;
  assert.equal(failedRun.status, 'error'); assert.equal(requests.length, 1);
  const original = await sample(); assert.equal(original.schedules.find(row => row.id === execution.id).errorHint, 'bad-request');
  // Durable owner sessions are external configuration; capture live and revoked records.
  for (const label of ['live', 'revoked']) {
    const response = await api('/api/owner/session', { body: {}, raw: true }); await boundedJson(response);
    const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); secrets.push(cookie, cookie.split('=')[1]);
    if (label === 'live') liveCookie = cookie;
    else { revokedCookie = cookie; await api('/api/owner/session', { method: 'DELETE', bearer: '', cookie }); }
  }
  await api('/api/owner/session', { bearer: '', cookie: liveCookie });
  await api('/api/owner/session', { status: 401, bearer: '', cookie: revokedCookie });
  const modelsFile = path.join(workspaceRoot, 'db/models.json');
  const modelBytes = await fs.readFile(modelsFile); assert.ok(!modelBytes.includes(Buffer.from(providerKey)));
  assert.ok(modelBytes.includes(Buffer.from('encrypted:'))); const metadataDigest = hash(await fs.readFile(metadataFile)), modelDigest = hash(modelBytes);
  check('Original protected installation diagnoses one actual failed job and retains encrypted credentials and owner sessions');
  await stop();
  const files = await inventory(data, 'data/');
  for (const [filename, name] of [[operator.env.FLUJO_OWNER_AUTH_FILE, 'owner.json'], [mount, 'encryption-secret']]) {
    const bytes = await fs.readFile(filename); files.push({ name: `external/${name}`, bytes, size: bytes.length, sha256: hash(bytes) });
  }
  files.push(...await inventory(operator.env.FLUJO_OWNER_AUTH_FILE + '.sessions', 'external/owner.json.sessions/'));
  files.sort((a, b) => a.name.localeCompare(b.name)); baseline = publicInventory(files); snapshotDigest = hash(Buffer.from(JSON.stringify(baseline)));
  const zip = new JSZip(); for (const entry of files) zip.file(entry.name, entry.bytes); zip.file('manifest.json', JSON.stringify(baseline));
  const plaintext = await zip.generateAsync({ type: 'nodebuffer' }), archiveBytes = seal(plaintext); archiveDigest = hash(archiveBytes);
  const archive = path.join(root, 'installation-backup.encrypted'); await write(archive, archiveBytes);
  assert.deepEqual(open(await fs.readFile(archive), archiveDigest), plaintext);
  check('Stopped full-root and separate authority/key/session capture is encrypted and verified before restore');
  if (args[5] === 'captured') throw new Error('Witnessed captured-backup failure before publication.');
  const publishedBefore = publicInventory(await inventory(data));
  const corrupt = Buffer.from(archiveBytes); corrupt[corrupt.length - 2] ^= 1;
  assert.throws(() => open(corrupt, archiveDigest)); assert.throws(() => open(archiveBytes, archiveDigest, randomBytes(32)));
  const failedStage = path.join(root, 'failed-stage');
  await assert.rejects(stage(plaintext, failedStage, 2), /Witnessed staging interruption/);
  assert.deepEqual(publicInventory(await inventory(data)), publishedBefore);
  assert.equal(await exists(path.join(failedStage, 'data')), true);
  check('Invalid backup/wrong archive key and interrupted staging preserve the published installation');
  const staging = path.join(root, 'verified-stage'); await stage(open(await fs.readFile(archive), archiveDigest), staging);
  await fs.rename(data, path.join(root, 'lost-data'));
  await fs.rename(staging + '/data', data);
  await fs.rename(operator.env.FLUJO_OWNER_AUTH_FILE, path.join(root, 'lost-owner.json'));
  await fs.rename(operator.env.FLUJO_OWNER_AUTH_FILE + '.sessions', path.join(root, 'lost-owner.sessions'));
  await fs.rename(mount, path.join(root, 'lost-encryption-secret'));
  assert.deepEqual(publicInventory(await inventory(data)), publishedBefore);
  check('Verified complete namespaces and hidden installation files publish back to original paths with one installation active');
  await start('restored-data-missing-owner-and-mount');
  for (const endpoint of ['/api/operations/status', '/api/owner/session']) {
    const denied = await api(endpoint, { status: 500, bearer: endpoint.endsWith('session') ? '' : operator.token, cookie: liveCookie, raw: true });
    await denied.body?.cancel();
  }
  assert.ok(serverLog.includes('Restore or repair the matching private owner policy at FLUJO_OWNER_AUTH_FILE with a current active owner credential'));
  assert.ok(!serverLog.includes('Restart with FLUJO_EXPOSURE_MODE=localhost'));
  await health(false);
  assert.equal(hash(await fs.readFile(metadataFile)), metadataDigest); assert.equal(hash(await fs.readFile(modelsFile)), modelDigest); assert.equal(requests.length, 1);
  check('Missing configured owner policy refuses startup/readiness and explains matching-policy recovery for bearer and browser access'); await stop();
  await fs.copyFile(path.join(staging, 'external/owner.json'), operator.env.FLUJO_OWNER_AUTH_FILE);
  await fs.cp(path.join(staging, 'external/owner.json.sessions'), operator.env.FLUJO_OWNER_AUTH_FILE + '.sessions', { recursive: true });
  await start('restored-owner-missing-encryption-mount');
  await api('/api/owner/session', { bearer: '', cookie: liveCookie });
  await api('/api/owner/session', { status: 401, bearer: '', cookie: revokedCookie });
  await api('/api/operations/status', { status: 423 }); await api('/api/model', { status: 423 });
  await health(false);
  assert.equal(hash(await fs.readFile(metadataFile)), metadataDigest); assert.equal(hash(await fs.readFile(modelsFile)), modelDigest);
  check('Restored live/revoked owner sessions retain their decisions while missing protection mount keeps credentials locked'); await stop();
  await write(mount, randomBytes(32).toString('base64url'));
  await start('restored-owner-mismatched-encryption-mount');
  await api('/api/operations/status', { status: 423 }); await api('/api/model', { status: 423 });
  await health(false);
  assert.equal(hash(await fs.readFile(metadataFile)), metadataDigest); assert.equal(hash(await fs.readFile(modelsFile)), modelDigest); assert.equal(requests.length, 1);
  check('Mismatched protected mount refuses credentials without replacing metadata or ciphertext'); await stop();
  await fs.writeFile(mount, await fs.readFile(path.join(staging, 'external/encryption-secret')), { mode: 0o600 });
  await start('complete-restored-operator-installation');
  await health(true);
  const restored = await sample();
  assert.equal(restored.actor.ownerId, original.actor.ownerId); assert.equal(restored.actor.credentialId, original.actor.credentialId);
  const retained = restored.schedules.find(row => row.id === execution.id);
  assert.equal(retained.enabled, true); assert.equal(retained.armed, false);
  assert.equal(retained.generationId, execution.generationId); assert.equal(retained.indexedLastRun.runId, failedRun.runId); assert.equal(retained.errorHint, 'bad-request');
  await api('/api/owner/session', { bearer: '', cookie: liveCookie }); await api('/api/owner/session', { status: 401, bearer: '', cookie: revokedCookie });
  await delay(2200, undefined, { signal: budget.signal }); await sample(); assert.equal(requests.length, 1, 'Restored paused work automatically replayed.');
  check('Matching independently restored key recovers authority and failure identities; paused work stays unarmed without provider replay');
  mode = 'success';
  const recoveredRun = (await api(`/api/planned-executions/${execution.id}/run`, { body: {} })).record;
  assert.equal(recoveredRun.status, 'completed'); assert.notEqual(recoveredRun.runId, failedRun.runId); assert.equal(requests.length, 2);
  assert.equal(recoveredRun.outputText, 'Restored fixture completed.');
  const history = (await api(`/api/planned-executions/${execution.id}/runs`)).runs;
  assert.equal(history.find(row => row.runId === failedRun.runId).status, 'error');
  assert.equal(history.find(row => row.runId === recoveredRun.runId).status, 'completed');
  assert.equal(hash(await fs.readFile(metadataFile)), metadataDigest); assert.equal(hash(await fs.readFile(modelsFile)), modelDigest);
  assert.equal(hash(await fs.readFile(archive)), archiveDigest);
  check('Explicit post-restore retry decrypts the original provider key, preserves failed history, and produces exactly one new provider request');
  await stop();
  await verifyBuildEvidence(application, args[3]);
  for (const [name, digest] of Object.entries(equipment)) assert.equal(hash(await fs.readFile(new URL(name, import.meta.url))), digest, 'Equipment changed during the attempt.');
} catch (error) { failure = error; }
finally {
  const recordFailure = error => { failure = failure ? new AggregateError([failure, error], 'Restore drill and cleanup failed.') : error; };
  try { budget.assertOpen(); } catch (error) { recordFailure(error); }
  clearTimeout(timer);
  try { await stop(); } catch (error) { recordFailure(error); }
  try { provider.closeAllConnections(); if (provider.listening) await withTimeout(new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve())), 5000, 'owned provider close'); providerClosed = true; }
  catch (error) { recordFailure(error); }
  try {
    assert.equal(providerClosed, true); assert.ok(generations.every(row => row.receipt.parentExitObserved && row.receipt.stdioCloseObserved && !row.receipt.abandoned && !row.receipt.failure));
    assert.equal(await fs.realpath(root), privateIdentity); assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await operator.restore(); assert.equal(await exists(root), false); cleanupVerified = true;
  } catch (error) { recordFailure(error); }
  try { budget.assertOpen(); } catch (error) { recordFailure(error); }
  const receipt = { schemaVersion: 1, scenario: 'source-complete-installation-restore-570', outcome: failure ? 'failed' : 'passed',
    startedAt, completedAt: new Date().toISOString(), platform: process.platform, node: process.version,
    sourceRevision: build.sourceRevision, buildId: build.buildId, sourceInputs: build.sourceInputs, builtInputs: build.builtInputs,
    buildEvidenceSha256: build.evidenceSha256, ownerIssuerSourceSha256: operator.issuerSourceSha256,
    archiveSha256: archiveDigest, fullInventorySha256: snapshotDigest, inventoryFiles: baseline?.length,
    checks, requests, generations: generations.map(row => row.receipt), budget: budget.receipt(), providerClosed,
    cleanup: { privateRoot: root, verifiedAbsent: cleanupVerified },
    failure: failure ? String(failure.stack ?? failure) : null,
    equipment,
    limits: ['Source-built Windows/Node operator-secret fixture; no installed/container/release or non-author installation/upgrade qualification.',
      'Regular-file stopped offline capture; no linked filesystem, concurrent-writer, physical disk exhaustion or cross-version migration claim.',
      'Same canonical paths/origin, one active restored installation; complete identical clones are not independently fenced.',
      'Four explicitly disabled fixture App records and loopback provider; no genuine cloud account/billing, bundled consent/process or worker bootstrap recovery claim.',
      'Live/revoked owner sessions and paused failed-run history; pending tool approval and worker uncertainty use their separate source drills.'] };
  let serialized = JSON.stringify(receipt, null, 2);
  for (const secret of secrets) { serverLog = serverLog.split(secret).join('[redacted]'); serialized = serialized.split(secret).join('[redacted]'); }
  archiveKey.fill(0);
  await fs.writeFile(report + '.log', serverLog, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(report, serialized + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ outcome: receipt.outcome, checks: checks.length, generations: generations.length, cleanupVerified, report }));
  if (failure) { console.error('Installation restore drill failed; inspect private evidence.'); process.exitCode = 1; }
}
