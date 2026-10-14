// Run through flujo-bash. Root owns final deletion of the reported private fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { readPrivateJson } from '../local-instance.mjs';
import { createSmokeOperator } from '../smoke-bundled-operator.mjs';
import { withTimeout } from '../mcp-smoke-cleanup.mjs';
import { boundedJson } from '../worker-recovery-acceptance.mjs';
import { inspectRecoveryApplication, observeRecoveryWorker, recoveryBudget } from '../worker-recovery-runtime.mjs';
import { verifyBuildEvidence } from './build-evidence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const usage = 'operator-upgrade.mjs --baseline-application <absolute-path> --candidate-application <absolute-path> '
  + '--baseline-build-evidence <absolute-path> --candidate-build-evidence <absolute-path> --report <new-absolute-path>';
export function parseOperatorUpgradeArguments(args) {
  assert.equal(args.length, 10, usage);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, '');
    assert.ok(['baseline-application', 'candidate-application', 'baseline-build-evidence', 'candidate-build-evidence', 'report'].includes(name)
      && args[index] === `--${name}` && !Object.hasOwn(values, name) && path.isAbsolute(args[index + 1]), usage);
    values[name] = path.resolve(args[index + 1]);
  }
  assert.notEqual(values['baseline-application'], values['candidate-application'], 'Use two different actual source builds.');
  return values;
}

export function sealOfflineArchive(plaintext, key) {
  assert.equal(key.length, 32);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('flujo-source-operator-upgrade-v1'));
  return Buffer.from(JSON.stringify({ schemaVersion: 1, iv: iv.toString('base64'),
    data: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') }));
}
export function openOfflineArchive(bytes, digest, key) {
  assert.equal(hash(bytes), digest, 'Offline backup digest mismatch.');
  assert.equal(key.length, 32);
  const envelope = JSON.parse(bytes);
  assert.equal(envelope.schemaVersion, 1);
  const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
  assert.equal(iv.length, 12); assert.equal(tag.length, 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from('flujo-source-operator-upgrade-v1')); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
}

export function assertDiagnosticRevision(diagnostic) {
  assert.equal(diagnostic?.checks?.revision, 'self-report-matches',
    'Operator attention exit does not establish a matching source revision.');
}

/** Final admission runs only after original processes, streams and provider handlers settle. */
export function concludeOperatorAttempt({ failure, budget, requests, checks, generations, providerClosed, providerHandlersSettled }) {
  try {
    budget.assertOpen();
    assert.ok(providerClosed && providerHandlersSettled, 'Provider closure and all admitted handlers must be observed.');
    assert.deepEqual(requests.map(({ sequence, mode, generation, credentialMatched }) => ({ sequence, mode, generation, credentialMatched })), [
      { sequence: 1, mode: 'failure', generation: 1, credentialMatched: true },
      { sequence: 2, mode: 'success', generation: 3, credentialMatched: true },
      { sequence: 3, mode: 'success', generation: 4, credentialMatched: true },
    ], 'Final provider census must contain exactly the three explicitly admitted credential-backed effects.');
    assert.deepEqual(checks.map(check => check.generation), [1, 1, 2, 2, 3, 3, 4], 'All seven source-operator checkpoints must complete.');
    assert.deepEqual(generations.map(row => ({ generation: row.generation, role: row.role })), [
      { generation: 1, role: 'baseline' }, { generation: 2, role: 'candidate' },
      { generation: 3, role: 'candidate' }, { generation: 4, role: 'baseline' },
    ], 'All four intended source generations must be observed.');
    assert.ok(generations.every(row => row.parentExitObserved && row.stdioCloseObserved && row.nextExitObserved
      && row.listenerClosed && row.registrationRemoved && !row.abandoned && !row.failure
      && row.nextHandle?.kind === 'original-next-handle' && row.nextExit?.kind === 'original-next-exit'
      && row.nextHandle.pid === row.nextExit.pid && row.nextHandle.startedAt === row.nextExit.startedAt
      && row.nextHandle.launcherPid === row.pid && row.nextHandleObserver?.parentExitObserved
      && row.nextHandleObserver.stdioCloseObserved && row.nextHandleObserver.exitCode === 0),
    'Final admission requires every original launcher/Next handle exit, stream close and listener/registration closure.');
  } catch (error) { return failure ?? error; }
  return failure;
}

// Open and retain the original Next process handle before accepting a generation.
// Windows Kill() is a forced termination. No PID/tree lookup occurs at stop time.
const windowsNextHandle = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$original = $null
try {
  $nextId = [int][Environment]::GetEnvironmentVariable('FLUJO_ACCEPTANCE_NEXT_PID')
  $launcherId = [int][Environment]::GetEnvironmentVariable('FLUJO_ACCEPTANCE_LAUNCHER_PID')
  $original = [Diagnostics.Process]::GetProcessById($nextId)
  $held = $original.Handle
  if ($original.HasExited) { throw 'exited' }
  $binary = [IO.Path]::GetFullPath($original.MainModule.FileName)
  if ($binary -ne [IO.Path]::GetFullPath([Environment]::GetEnvironmentVariable('FLUJO_ACCEPTANCE_NODE_PATH'))) { throw 'binary' }
  $relation = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $nextId)
  if ($relation.ParentProcessId -ne $launcherId) { throw 'parent' }
  $birth = $original.StartTime.ToUniversalTime().ToString('o')
  [Console]::WriteLine((@{kind='original-next-handle';pid=$nextId;launcherPid=$launcherId;startedAt=$birth} | ConvertTo-Json -Compress))
  if ([Console]::ReadLine() -ne 'force') { throw 'stop' }
  $forced = -not $original.HasExited
  if ($forced) { $original.Kill() }
  if (-not $original.WaitForExit(15000)) { throw 'wait' }
  [Console]::WriteLine((@{kind='original-next-exit';pid=$nextId;startedAt=$birth;forced=$forced;exitCode=$original.ExitCode} | ConvertTo-Json -Compress))
} catch {
  [Console]::WriteLine('{"kind":"original-next-observation-failed"}')
  [Environment]::Exit(1)
} finally { if ($null -ne $original) { $original.Dispose() } }
`;

export async function runOperatorUpgrade(values) {
  assert.equal(process.platform, 'win32', 'This focused source-launch qualification is for Windows.');
  const report = values.report;
  await assert.rejects(fs.access(report), { code: 'ENOENT' });
  await assert.rejects(fs.access(report + '.log'), { code: 'ENOENT' });
  const applications = { baseline: values['baseline-application'], candidate: values['candidate-application'] };
  assert.equal(await fs.realpath(applications.candidate), await fs.realpath(fileURLToPath(new URL('../../', import.meta.url))));
  const builds = {};
  for (const role of ['baseline', 'candidate']) builds[role] = await verifyBuildEvidence(applications[role], values[`${role}-build-evidence`]);
  assert.notEqual(builds.baseline.sourceRevision, builds.candidate.sourceRevision);
  const versions = {};
  for (const role of ['baseline', 'candidate']) versions[role] = JSON.parse(await fs.readFile(path.join(applications[role], 'package.json'), 'utf8')).version;
  assert.equal(versions.baseline, '3.46.2'); assert.equal(versions.candidate, '3.46.3');
  const operator = await createSmokeOperator();
  const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE), rootIdentity = await fs.realpath(root);
  const data = path.join(root, 'data'), workspace = 'default-workspace', workspaceRoot = path.join(data, 'workspaces', workspace);
  const passphraseFile = path.join(root, 'encryption-passphrase'), passphrase = randomBytes(32).toString('base64url');
  const providerKey = randomBytes(32).toString('base64url'), archiveKey = randomBytes(32);
  const secrets = [operator.token, passphrase, providerKey, archiveKey.toString('base64')];
  const budget = recoveryBudget({ totalMs: 420_000 }), generations = [], checks = [], requests = [], diagnoses = [], backups = [];
  const startedAt = new Date().toISOString();
  let current, base, mode = 'failure', providerClosed = false, providerHandlersSettled = false, failure, output = '', timer, execution, failedRun, liveCookie, revokedCookie;
  const exists = async file => Boolean(await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }));
  const write = async (file, bytes) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); };
  const check = name => { checks.push({ name, generation: generations.length, observedUtc: new Date().toISOString() }); console.log(`Passed: ${name}`); };
  const privateChildEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(name)));
  const addOutput = bytes => { try { budget.chargeOutput(bytes.length); output = (output + bytes).slice(-2 * 1024 * 1024); }
    catch (error) { budget.refuse(error); } };
  async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return server.address().port;
  }
  async function unusedPort() { const server = net.createServer(), port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
  async function portOpen() {
    return new Promise(resolve => { const socket = net.connect(Number(new URL(base).port), '127.0.0.1');
      const settle = value => { socket.destroy(); resolve(value); };
      socket.once('connect', () => settle(true)); socket.once('error', () => settle(false)); socket.setTimeout(1000, () => settle(true)); });
  }
  async function api(endpoint, { body, method = body === undefined ? 'GET' : 'POST', status = 200, bearer = operator.token, cookie } = {}) {
    budget.assertOpen(); const url = new URL(endpoint, base); url.searchParams.set('workspace', workspace);
    const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.any([budget.signal, AbortSignal.timeout(30_000)]),
      headers: { origin: base, 'sec-fetch-site': 'same-origin', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), `${method} ${endpoint} returned unexpected HTTP ${response.status}.`);
    const result = await boundedJson(response);
    return { status: response.status, body: result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const providerHandlers = new Set();
  async function handleProvider(request, response) {
    try {
      assert.ok(request.method === 'POST' && request.url === '/v1/chat/completions' && request.headers.authorization === `Bearer ${providerKey}`,
        'Fixture provider received an inadmissible request or credential.');
      let bytes = ''; for await (const chunk of request) { bytes += chunk; assert.ok(bytes.length <= 128 * 1024); }
      const input = JSON.parse(bytes); assert.ok(requests.length < 3, 'Unexpected automatic retry/replay.');
      const row = { sequence: requests.length + 1, mode, generation: generations.length, observedUtc: new Date().toISOString(), credentialMatched: true };
      requests.push(row); await fs.appendFile(path.join(root, 'provider-effects.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
      if (mode === 'failure') { response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Synthetic source upgrade fixture bad request.', type: 'invalid_request_error', code: 'bad_request' } })); return; }
      const info = { id: `operator-upgrade-fixture-${row.sequence}`, model: input.model, created: Math.floor(Date.now() / 1000) };
      if (input.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Source upgrade fixture completed.' }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else { response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...info, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Source upgrade fixture completed.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })); }
    } catch { budget.refuse(new Error('Fixture provider refused an inadmissible request.')); response.writeHead(500); response.end(); }
  }
  const provider = http.createServer((request, response) => {
    const handler = handleProvider(request, response); providerHandlers.add(handler);
    handler.then(() => providerHandlers.delete(handler), error => { budget.refuse(error); providerHandlers.delete(handler); });
  });

  async function start(role, profile) {
    budget.assertOpen(); assert.ok(!current && generations.length < 4); assert.equal(await portOpen(), false);
    const application = applications[role], env = { ...privateChildEnvironment(), ...operator.env,
      NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'home/roaming'), LOCALAPPDATA: path.join(root, 'home/local'),
      TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), TMPDIR: path.join(root, 'temp'),
      FLUJO_APP_ROOT: application, FLUJO_DATA_DIR: data, FLUJO_RUNTIME_ENV_DIR: application,
      FLUJO_OWNER_BROWSER_ORIGIN: base, FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_BASE_URL: base, FLUJO_PORT: new URL(base).port,
      FLUJO_BUILD_REVISION: builds[role].sourceRevision, FLUJO_LOCAL_INSTANCE_DIR: path.join(root, 'local-instances'),
      FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(await unusedPort()) };
    await inspectRecoveryApplication(application, env);
    const args = [path.join(application, 'scripts/launch-next.mjs'), 'start', '--hostname', '127.0.0.1', '--port', new URL(base).port];
    const child = spawn(process.execPath, args, { cwd: application, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    current = { ...observeRecoveryWorker(child, generations.length + 1), env, role, registration: null, monitor: null };
    Object.assign(current.receipt, { role, profile, command: [process.execPath, ...args], cwd: application,
      sourceRevision: builds[role].sourceRevision, buildId: builds[role].buildId, version: versions[role], launch: 'normal-source-launcher', shutdown: 'not-yet-observed' });
    generations.push(current); child.stdout.on('data', addOutput); child.stderr.on('data', addOutput);
    const owned = current, deadline = Date.now() + 60_000;
    for (;;) {
      budget.assertOpen(); assert.equal(owned.observation.exited, false, 'Actual launcher exited before registration.');
      const names = await fs.readdir(env.FLUJO_LOCAL_INSTANCE_DIR).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      const candidates = names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
      assert.ok(candidates.length <= 1, 'Another instance or a stale registration is present in the owned fixture.');
      if (candidates.length) {
        const file = path.join(env.FLUJO_LOCAL_INSTANCE_DIR, candidates[0]), registration = await readPrivateJson(file);
        assert.ok(registration.format === 'flujo-local-instance' && registration.version === 1
          && registration.appRoot === application && registration.dataRoot === data && registration.origin === base
          && Number.isSafeInteger(registration.pid) && registration.pid > 0, 'Actual launcher registration does not identify the expected source/data/origin.');
        secrets.push(registration.token); owned.registration = file; owned.receipt.nextPid = registration.pid;
        const monitorEnv = { ...privateChildEnvironment(), FLUJO_ACCEPTANCE_NEXT_PID: String(registration.pid),
          FLUJO_ACCEPTANCE_LAUNCHER_PID: String(child.pid), FLUJO_ACCEPTANCE_NODE_PATH: process.execPath };
        const monitorChild = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsNextHandle, 'utf16le').toString('base64')],
          { env: monitorEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const monitor = observeRecoveryWorker(monitorChild, `next-handle-${generations.length}`); owned.monitor = monitor;
        let monitorOutput = '', resolveReady, rejectReady;
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        monitorChild.stdout.on('data', bytes => {
          try { budget.chargeOutput(bytes.length); monitorOutput += bytes; assert.ok(monitorOutput.length < 8192);
            if (monitorOutput.includes('\n') && !owned.receipt.nextHandle) {
              const identity = JSON.parse(monitorOutput.split('\n')[0]);
              assert.ok(identity.kind === 'original-next-handle' && identity.pid === registration.pid && identity.launcherPid === child.pid);
              owned.receipt.nextHandle = identity; resolveReady();
            }
          } catch (error) { rejectReady(error); }
        });
        monitorChild.stderr.on('data', addOutput);
        monitor.observation.exit.then(() => { if (!owned.receipt.nextHandle) rejectReady(new Error('Original Next handle admission failed.')); });
        monitor.output = () => monitorOutput;
        await withTimeout(ready, 20_000, 'original Windows Next process handle'); break;
      }
      assert.ok(Date.now() < deadline, 'Actual source launcher did not register its original Next process.'); await delay(100, undefined, { signal: budget.signal });
    }
    for (;;) {
      budget.assertOpen(); assert.equal(owned.observation.exited, false);
      try {
        const result = await api('/api/encryption/secure', { body: { action: 'check_initialized' }, status: [200, 503] });
        if (result.status === 200) break;
      } catch (error) { if (!(error instanceof TypeError) || Date.now() >= deadline) throw error; }
      assert.ok(Date.now() < deadline, 'Actual source application did not accept initialization inspection.'); await delay(200, undefined, { signal: budget.signal });
    }
  }
  async function stop() {
    if (!current) return;
    const owned = current, monitor = owned.monitor;
    assert.ok(monitor && owned.receipt.nextHandle, 'Cannot stop an unobserved Next process by PID.');
    if (!monitor.observation.exited) monitor.observation.child.stdin.end('force\n');
    await withTimeout(monitor.observation.exit, 20_000, 'original retained Next handle exit');
    await withTimeout(monitor.observation.close, 5_000, 'Next handle observer stdio close');
    assert.equal(monitor.receipt.exitCode, 0, 'Original Next process observer failed.');
    const rows = monitor.output().trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2); const terminal = rows[1];
    assert.ok(terminal.kind === 'original-next-exit' && terminal.pid === owned.receipt.nextHandle.pid
      && terminal.startedAt === owned.receipt.nextHandle.startedAt, 'Original Next exit does not match its admitted handle.');
    owned.receipt.nextExit = terminal; owned.receipt.nextExitObserved = true;
    owned.receipt.nextHandleObserver = monitor.receipt;
    await withTimeout(owned.observation.exit, 15_000, 'original source launcher exit');
    await withTimeout(owned.observation.close, 5_000, 'original source launcher stdio close');
    assert.equal(owned.receipt.parentExitObserved, true); assert.equal(owned.receipt.stdioCloseObserved, true);
    assert.equal(await portOpen(), false, 'Owned source listener remains open after actual exits.');
    assert.equal(await exists(owned.registration), false, 'Normal launcher left its own registration behind.');
    owned.receipt.listenerClosed = true; owned.receipt.registrationRemoved = true;
    owned.receipt.shutdown = terminal.forced ? 'forced-original-Next-handle;launcher-exit-observed' : 'Next-already-exited;launcher-exit-observed';
    current = undefined;
  }
  async function inventory(directory, prefix = '') {
    const files = [];
    async function visit(folder, relative) {
      for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        assert.ok(!entry.isSymbolicLink(), 'This stopped regular-file fixture does not qualify linked backup.');
        const filename = path.join(folder, entry.name), name = relative + entry.name;
        if (entry.isDirectory()) await visit(filename, name + '/');
        else { const stat = await fs.lstat(filename); assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 4 * 1024 * 1024);
          const bytes = await fs.readFile(filename); files.push({ name, size: bytes.length, sha256: hash(bytes), bytes }); }
        assert.ok(files.length <= 2000 && files.reduce((sum, row) => sum + row.size, 0) <= 32 * 1024 * 1024, 'Offline fixture backup exceeded its budget.');
      }
    }
    await visit(directory, prefix); return files;
  }
  const publicInventory = files => files.map(({ name, size, sha256 }) => ({ name, size, sha256 }));
  async function completeInventory() {
    const files = await inventory(data, 'data/');
    for (const [file, name] of [[operator.env.FLUJO_OWNER_AUTH_FILE, 'owner.json'], [passphraseFile, 'passphrase']]) {
      const bytes = await fs.readFile(file); files.push({ name: `external/${name}`, size: bytes.length, sha256: hash(bytes), bytes });
    }
    if (await exists(operator.env.FLUJO_OWNER_AUTH_FILE + '.sessions')) files.push(...await inventory(operator.env.FLUJO_OWNER_AUTH_FILE + '.sessions', 'external/owner.json.sessions/'));
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function capture(role) {
    assert.ok(!current, 'Full backup requires both original application processes to have exited.');
    const files = await completeInventory(), manifest = publicInventory(files), zip = new JSZip();
    for (const entry of files) zip.file(entry.name, entry.bytes); zip.file('manifest.json', JSON.stringify(manifest));
    const plaintext = await zip.generateAsync({ type: 'nodebuffer' }), encrypted = sealOfflineArchive(plaintext, archiveKey), digest = hash(encrypted);
    const archive = path.join(root, `${role}-stopped-root.encrypted`); await write(archive, encrypted);
    assert.deepEqual(openOfflineArchive(await fs.readFile(archive), digest, archiveKey), plaintext);
    assert.deepEqual(publicInventory(await completeInventory()), manifest, 'Stopped root changed during full capture.');
    const result = { role, archive, sha256: digest, bytes: encrypted.length, inventorySha256: hash(JSON.stringify(manifest)), members: manifest.length, manifest };
    backups.push({ role, sha256: digest, bytes: encrypted.length, inventorySha256: result.inventorySha256, members: manifest.length }); return result;
  }
  async function stage(backup, folder, failAfter) {
    const plaintext = openOfflineArchive(await fs.readFile(backup.archive), backup.sha256, archiveKey), zip = await JSZip.loadAsync(plaintext);
    const manifest = JSON.parse(await zip.file('manifest.json').async('string')); assert.deepEqual(manifest, backup.manifest);
    assert.deepEqual(Object.values(zip.files).filter(row => !row.dir && row.name !== 'manifest.json').map(row => row.name).sort(), manifest.map(row => row.name).sort());
    let written = 0;
    for (const member of manifest) {
      assert.ok(/^(data|external)\/[A-Za-z0-9_.\/-]+$/.test(member.name) && !member.name.split('/').includes('..'));
      const bytes = await zip.file(member.name).async('nodebuffer'); assert.equal(bytes.length, member.size); assert.equal(hash(bytes), member.sha256);
      await write(path.join(folder, member.name), bytes);
      if (++written === failAfter) throw new Error('Witnessed stopped staging interruption before publication.');
    }
    assert.deepEqual(publicInventory(await inventory(folder)), manifest);
  }
  async function publish(backup, label) {
    assert.ok(!current, 'Never publish data/configuration under a running source installation.');
    assert.equal(await fs.realpath(root), rootIdentity); assert.equal(await portOpen(), false);
    const folder = path.join(root, `${label}-verified-stage`); await stage(backup, folder);
    const parked = path.join(root, `${label}-previous-root`); await fs.mkdir(parked);
    await fs.rename(data, path.join(parked, 'data')); await fs.rename(path.join(folder, 'data'), data);
    for (const [name, target] of [['owner.json', operator.env.FLUJO_OWNER_AUTH_FILE], ['passphrase', passphraseFile], ['owner.json.sessions', operator.env.FLUJO_OWNER_AUTH_FILE + '.sessions']]) {
      if (await exists(target)) await fs.rename(target, path.join(parked, name));
      if (await exists(path.join(folder, 'external', name))) await fs.rename(path.join(folder, 'external', name), target);
    }
    assert.deepEqual(publicInventory(await completeInventory()), backup.manifest, 'Published full data/configuration differs from its verified snapshot.');
    assert.equal(await fs.realpath(data), data); assert.equal(await fs.readFile(passphraseFile, 'utf8'), passphrase);
  }
  async function unlock() {
    await api('/api/cwd', { status: 423 });
    await api('/api/encryption/secure', { body: { action: 'authenticate', password: 'incorrect-fixture-passphrase' }, status: 401 });
    const result = await api('/api/encryption/secure', { body: { action: 'authenticate', password: await fs.readFile(passphraseFile, 'utf8') } });
    assert.equal(result.body.success, true); secrets.push(result.body.token);
    assert.equal((await api('/api/init')).body.success, true);
    const identity = (await api('/api/cwd')).body;
    assert.equal(identity.cwd, applications[current.role]); assert.equal(identity.mcpServersDir, path.join(workspaceRoot, 'mcp-servers'));
    const servers = (await api('/api/mcp/servers')).body;
    assert.ok(Array.isArray(servers) && servers.length === 4 && servers.every(server => server.disabled === true),
      'The source fixture must keep every shipped App explicitly disabled.');
    current.receipt.disabledAppsVerified = servers.map(server => server.name).sort();
  }
  async function retainedFailure() {
    const list = (await api('/api/planned-executions')).body; assert.equal(list.paused, true);
    const row = list.executions.find(item => item.execution.id === execution.id);
    assert.ok(row && row.execution.enabled && !row.status.armed && row.lastRun.runId === failedRun.runId && row.lastRun.status === 'error');
    const runs = (await api(`/api/planned-executions/${execution.id}/runs`)).body.runs;
    assert.equal(runs.length, 1); assert.equal(runs[0].runId, failedRun.runId); assert.equal(runs[0].status, 'error');
    assert.equal(requests.length, 1, 'Installation/restore unexpectedly replayed the original failed work.');
  }
  async function diagnose(label) {
    const filename = report + `.${label}.json`, args = [path.join(applications.candidate, 'scripts/operations-inspect.mjs'),
      '--base-url', base, '--workspace', workspace, '--expected-revision', builds.candidate.sourceRevision, '--report', filename];
    await assert.rejects(fs.access(filename), { code: 'ENOENT' });
    const child = spawn(process.execPath, args, { cwd: applications.candidate,
      env: { ...privateChildEnvironment(), FLUJO_OPERATIONS_TOKEN: operator.token }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const observed = observeRecoveryWorker(child, `operator-cli-${diagnoses.length + 1}`); child.stdout.on('data', addOutput); child.stderr.on('data', addOutput);
    await withTimeout(observed.observation.exit, 15_000, 'actual operator CLI exit'); await withTimeout(observed.observation.close, 5_000, 'actual operator CLI stdio close');
    assert.equal(observed.receipt.exitCode, 2, 'Seeded failed schedule requires operator attention.');
    const bytes = await fs.readFile(filename), diagnostic = JSON.parse(bytes), snapshot = diagnostic.snapshot;
    assertDiagnosticRevision(diagnostic);
    assert.equal(diagnostic.checks.runtimeAcceptance, false); assert.equal(snapshot.complete, true); assert.equal(snapshot.scheduler.armedTriggers, 0);
    assert.equal(snapshot.scheduler.pausedInStoredConfig, true); assert.equal(snapshot.scheduler.runningRuns, 0); assert.deepEqual(snapshot.processes, []);
    assert.equal(snapshot.schedules.find(row => row.id === execution.id).errorHint, 'bad-request');
    diagnoses.push({ label, path: filename, sha256: hash(bytes), sourceRevision: builds.candidate.sourceRevision, exitCode: 2, revisionCheck: diagnostic.checks.revision,
      observationProcessId: snapshot.observationProcessId, actor: snapshot.actor, originalCli: observed.receipt });
  }
  async function retry(expectedCount) {
    mode = 'success'; const run = (await api(`/api/planned-executions/${execution.id}/run`, { body: {} })).body.record;
    assert.equal(run.status, 'completed'); assert.notEqual(run.runId, failedRun.runId); assert.equal(requests.length, expectedCount);
    const runs = (await api(`/api/planned-executions/${execution.id}/runs`)).body.runs;
    assert.equal(runs.length, 2); assert.equal(runs[0].runId, failedRun.runId); assert.equal(runs[1].runId, run.runId);
    return { runId: run.runId, status: run.status, effectSequence: expectedCount };
  }
  let baselineBackup, candidateBackup, restoredRetry, rollbackRetry;
  try {
    timer = setTimeout(() => budget.refuse(new Error('Source operator whole-window deadline exceeded.')), budget.remainingMs());
    for (const folder of ['home', 'home/roaming', 'home/local', 'temp']) await fs.mkdir(path.join(root, folder), { recursive: true });
    await write(passphraseFile, passphrase);
    const disabled = Object.fromEntries(['flujo', 'filesystem', 'bash', 'browser'].map(name => [name, {
      transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'], rootPath: `mcp-servers/${name}`, env: {}, disabled: true }]));
    for (const name of [workspace, 'second-fixture']) {
      await write(path.join(data, 'workspaces', name, 'db/mcp_servers.json'), JSON.stringify(disabled));
      await write(path.join(data, 'workspaces', name, 'db/planned_executions.json'), JSON.stringify({ version: 1, paused: true, executions: [] }));
    }
    await write(path.join(data, 'workspaces/second-fixture/userdata/proof.bin'), randomBytes(4096));
    await write(path.join(data, '.installation-private-proof'), randomBytes(32));
    const providerPort = await listen(provider); base = `http://127.0.0.1:${await unusedPort()}`;
    await start('baseline', 'original-3.46.2-source-installation'); assert.equal((await api('/api/init')).body.success, true);
    assert.equal((await api('/api/encryption/secure', { body: { action: 'initialize', password: passphrase } })).body.success, true);
    await unlock();
    const metadataFile = path.join(workspaceRoot, 'db/encryption_key.json'), metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    assert.equal(metadata.encryption_type, 'user'); assert.equal(metadata.encryption_version, 2); assert.equal(metadata.key_protection, undefined);
    await api('/api/model', { status: 201, body: { id: 'operator-upgrade-fixture-model', name: 'operator-upgrade-fixture-model',
      provider: 'openai', adapter: 'openai', ApiKey: providerKey, baseUrl: `http://127.0.0.1:${providerPort}/v1` } });
    const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: type, properties } });
    const nodes = [node('start', 'start'), node('process', 'process', { boundModel: 'operator-upgrade-fixture-model',
      promptTemplate: 'Reply to the user.', inputMode: 'full-history', allowQuestion: false }), node('finish', 'finish')];
    const edge = (a, b) => ({ id: `${a.id}->${b.id}`, source: a.id, target: b.id, sourceHandle: `${a.type}-bottom`, targetHandle: `${b.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
    await api('/api/flow', { status: 201, body: { id: 'operator-upgrade-fixture-flow', name: 'Source operator upgrade fixture', nodes,
      edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])], updatedAt: Date.now() } });
    execution = (await api('/api/planned-executions', { status: 201, body: { name: 'Source operator retained failed schedule', enabled: true,
      flowId: 'operator-upgrade-fixture-flow', prompt: 'Synthetic source upgrade.', saveConversations: true, approvalPolicy: 'pause',
      overlapStrategy: 'skip', startRestriction: 'singleton', trigger: { type: 'schedule', cron: '*/1 * * * * *', catchUp: true } } })).body.execution;
    failedRun = (await api(`/api/planned-executions/${execution.id}/run`, { body: {} })).body.record;
    assert.equal(failedRun.status, 'error'); await retainedFailure();
    const modelFile = path.join(workspaceRoot, 'db/models.json'), modelBytes = await fs.readFile(modelFile);
    assert.ok(!modelBytes.includes(Buffer.from(providerKey)) && modelBytes.includes(Buffer.from('encrypted:')));
    const metadataDigest = hash(await fs.readFile(metadataFile)), modelDigest = hash(modelBytes);
    check('Actual baseline source launcher authenticates private USER credentials and diagnoses one counted fixture failure');
    await stop(); baselineBackup = await capture('baseline');
    check('Both original baseline processes exited and encrypted complete-root/private-policy/passphrase backup verifies');
    await start('candidate', 'same-root-source-upgrade'); await api('/api/operations/status', { status: 401, bearer: '' }); await unlock();
    assert.equal(hash(await fs.readFile(metadataFile)), metadataDigest); assert.equal(hash(await fs.readFile(modelFile)), modelDigest);
    await retainedFailure(); await diagnose('candidate-upgrade');
    for (const label of ['live', 'revoked']) {
      const session = await api('/api/owner/session', { body: {} }); assert.ok(session.cookie); secrets.push(session.cookie, session.cookie.split('=')[1]);
      if (label === 'live') liveCookie = session.cookie;
      else { revokedCookie = session.cookie; await api('/api/owner/session', { method: 'DELETE', bearer: '', cookie: revokedCookie }); }
    }
    check('Actual candidate source launcher reads unchanged old encrypted records and diagnoses the original failed schedule without replay');
    await stop(); candidateBackup = await capture('candidate');
    const beforeRejected = publicInventory(await completeInventory()), archive = await fs.readFile(candidateBackup.archive), corrupt = Buffer.from(archive);
    corrupt[corrupt.length - 2] ^= 1;
    assert.throws(() => openOfflineArchive(corrupt, candidateBackup.sha256, archiveKey));
    assert.throws(() => openOfflineArchive(archive, candidateBackup.sha256, randomBytes(32)));
    await assert.rejects(stage(candidateBackup, path.join(root, 'interrupted-stage'), 2), /Witnessed stopped staging interruption/);
    assert.deepEqual(publicInventory(await completeInventory()), beforeRejected);
    await fs.writeFile(path.join(data, '.installation-private-proof'), 'offline-fixture-damage', { mode: 0o600 });
    await publish(candidateBackup, 'candidate-restore');
    check('Corrupt/wrong-key/interrupted staging refuses publication and full candidate backup restores original paths');
    await start('candidate', 'restored-candidate-source-installation'); await unlock(); await retainedFailure(); await diagnose('candidate-restored');
    await api('/api/owner/session', { bearer: '', cookie: liveCookie }); await api('/api/owner/session', { status: 401, bearer: '', cookie: revokedCookie });
    assert.notEqual(diagnoses[0].observationProcessId, diagnoses[1].observationProcessId);
    await delay(2200, undefined, { signal: budget.signal }); await retainedFailure(); restoredRetry = await retry(2);
    check('Restored candidate retains owner session decisions and admits exactly one explicit credential-backed retry');
    await stop(); await publish(baselineBackup, 'baseline-rollback');
    assert.equal(await exists(operator.env.FLUJO_OWNER_AUTH_FILE + '.sessions'), false);
    check('Rollback restores the compatible verified baseline data and private configuration before old code starts');
    await start('baseline', 'compatible-snapshot-source-rollback'); await unlock();
    const list = (await api('/api/planned-executions')).body, rollbackRow = list.executions.find(row => row.execution.id === execution.id);
    assert.ok(list.paused && rollbackRow.lastRun.runId === failedRun.runId && !rollbackRow.status.armed);
    assert.equal(hash(await fs.readFile(metadataFile)), metadataDigest); assert.equal(hash(await fs.readFile(modelFile)), modelDigest);
    await delay(2200, undefined, { signal: budget.signal }); assert.equal(requests.length, 2); rollbackRetry = await retry(3);
    check('Actual baseline rollback launcher decrypts original records and executes only its explicit retry');
  } catch (error) { failure = error; }
  finally {
    try { await stop(); } catch (error) { failure ??= error; }
    try {
      provider.closeAllConnections();
      await withTimeout(new Promise((resolve, reject) => provider.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())),
        10_000, 'fixture provider listener closure');
      providerClosed = true;
      await withTimeout(Promise.allSettled([...providerHandlers]), 10_000, 'all admitted fixture provider handlers');
      providerHandlersSettled = providerHandlers.size === 0;
    } catch (error) { failure ??= error; }
    failure = concludeOperatorAttempt({ failure, budget, requests, checks, generations: generations.map(row => row.receipt), providerClosed, providerHandlersSettled });
    clearTimeout(timer);
    const receipt = { schemaVersion: 1, kind: 'independent-automated-source-operator-upgrade', outcome: failure ? 'failed' : 'passed',
      startedAt, completedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
      actor: { kind: 'automated-technical-operator', humanOperated: false, productAuthorActions: false, issuerSourceSha256: operator.issuerSourceSha256 },
      builds: Object.fromEntries(['baseline', 'candidate'].map(role => [role, { application: applications[role], version: versions[role],
        sourceRevision: builds[role].sourceRevision, buildId: builds[role].buildId, buildEvidenceSha256: builds[role].evidenceSha256,
        sourceInputs: builds[role].sourceInputs, builtInputs: builds[role].builtInputs }])),
      fixture: { root, data, workspace, schedulerPaused: true, apps: 'four-explicitly-disabled', provider: 'counted-loopback-OpenAI-format-fixture' },
      backups, diagnoses, originalFailedRun: failedRun ? { runId: failedRun.runId, status: failedRun.status } : null,
      restoredRetry, rollbackRetry, requests, checks, generations: generations.map(row => row.receipt), budget: budget.receipt(), providerClosed, providerHandlersSettled,
      finalCensus: failure ? 'failed-or-incomplete' : 'exact-three-effects-seven-checkpoints-four-original-generations',
      cleanup: { privateRoot: root, ownership: 'this-run-only', originalApplicationsExited: generations.every(row => row.receipt.parentExitObserved && row.receipt.nextExitObserved
        && row.receipt.stdioCloseObserved && row.receipt.listenerClosed), needsFlujoBashDeletion: true, filesystemDeletionsPerformedByThisHarness: false },
      equipmentSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), failure: failure ? String(failure.stack ?? failure) : null,
      limits: ['Two exact locally built source revisions with the actual Windows source launcher; no npm package/installer/container/released-artifact qualification.',
        'Forced original-Next-handle shutdown, observed original launcher exit and stdio close; no graceful teardown, descendant generation or isolated-container-removal claim.',
        'Stopped regular-file complete-root capture at the original canonical paths, same Windows account and one active installation; no linked/concurrent-writer/disk-full migration claim.',
        'Baseline private USER passphrase compatibility; no public-default credential use, key-protection conversion or Security credential-migration acceptance claim.',
        'The historical baseline has USER unlock and loopback admission, without the current scoped owner-bearer boundary; candidate bearer/session admission is observed separately.',
        'Independent automated technical actor with source/byte-bound receipts and local provider effects; no human/genuine-provider/paid-account or independent scorecard judgment.',
        'Paused ordinary schedule with failed-run and restored live/revoked owner-session decisions; recurring worker uncertainty and pending tool approval remain in their separate drills.',
        'Fixture archives/private roots are disposable owned equipment; source-build hashes do not establish published-package identity.'] };
    let serialized = JSON.stringify(receipt, null, 2);
    for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 0)) { output = output.split(secret).join('[redacted]'); serialized = serialized.split(secret).join('[redacted]'); }
    archiveKey.fill(0); await fs.writeFile(report + '.log', output, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(report, serialized + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ outcome: receipt.outcome, checks: checks.length, generations: generations.length, report, privateRoot: root,
      originalApplicationsExited: receipt.cleanup.originalApplicationsExited }));
    return receipt;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { if ((await runOperatorUpgrade(parseOperatorUpgradeArguments(process.argv.slice(2)))).outcome !== 'passed') process.exitCode = 1; }
  catch { console.error('Source operator upgrade refused; inspect inputs and retained owned equipment.'); process.exitCode = 1; }
}
