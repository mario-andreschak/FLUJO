import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drillEnvironment } from './maintainer-drill.mjs';
import { assertInstalledIdentity, assertRestoredFlow, parseBaselineOptions, runInstalledBaseline } from './maintainer-installed-baseline.mjs';
import { stateSelections, readSyntheticState, assertSyntheticState, assertFreshSyntheticState,
  validateSyntheticStateReceipt, verifySyntheticStateArchive, validateFlowInventoryReceipt,
  readFlowInventory, canonicalFlowInventory, assertFlowInventory,
  restoreSyntheticState, invalidSyntheticStateArchives } from './maintainer-synthetic-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readBoundedFileSync } = createRequire(import.meta.url)('./read-bounded-file.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const usage = 'Usage: node scripts/maintainer-installed-recovery.mjs --version=VERSION '
  + '--integrity=SHA512_SRI --source-revision=SHA [--npm-cli=ABSOLUTE_NPM_CLI_JS]';

export function validateRecoveryInput(receipt, archive, original, expectedToolRevision) {
  const originalEvidence = receipt.evidence?.find(item => item.path === 'original-flow.json');
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'automated-installed-baseline-probe'
      || receipt.result !== 'passed-baseline-probe' || !receipt.sourceCleanBefore || !receipt.sourceCleanAfter
      || receipt.toolRevision !== expectedToolRevision || !receipt.semanticComparison?.passed
      || receipt.tarball?.observedIntegrity !== receipt.integrity
      || receipt.installedManifest?.name !== 'flujo-ai' || receipt.installedManifest?.version !== receipt.version
      || digest(archive) !== receipt.backup?.sha256 || archive.length !== receipt.backup?.bytes
      || digest(original) !== originalEvidence?.sha256 || original.length !== originalEvidence?.bytes) {
    throw new Error('Recovery input differs from the successful revision-bound baseline.');
  }
  const expected = JSON.parse(original);
  if (expected.id !== 'maintainer_drill_flow' || expected.name !== 'Synthetic maintainer recovery fixture'
      || !Array.isArray(expected.nodes) || expected.nodes.length || !Array.isArray(expected.edges) || expected.edges.length) {
    throw new Error('Recovery requires the prescribed empty synthetic flow; no execution data allowed.');
  }
  return expected;
}

function sourceIdentity() {
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true,
    timeout: 30000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))) }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision) || git(['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Fresh recovery requires clean unchanged committed tool source.');
  }
  return revision;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port }); let settled = false;
    const finish = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}

export function validateRecoveryTarget(receipt, expectedToolRevision) {
  if (receipt?.schemaVersion !== 1 || receipt.kind !== 'automated-installed-baseline-probe' || receipt.result !== 'passed-baseline-probe'
      || receipt.toolRevision !== expectedToolRevision || !receipt.sourceCleanBefore || !receipt.sourceCleanAfter
      || !receipt.semanticComparison?.passed || receipt.installedManifest?.name !== 'flujo-ai'
      || receipt.installedManifest.version !== receipt.version || receipt.tarball?.observedIntegrity !== receipt.integrity
      || !receipt.shutdown?.loopbackPortClosed || !receipt.shutdown.launcherExit
      || !/^[a-f0-9]{40}$/.test(receipt.declaredArtifactSourceRevision ?? '')) {
    throw new Error('Candidate consumer is not a stopped, successful revision-bound baseline.');
  }
  try {
    parseBaselineOptions([`--version=${receipt.version}`, `--integrity=${receipt.integrity}`, `--source-revision=${receipt.declaredArtifactSourceRevision}`]);
  } catch { throw new Error('Candidate consumer package pin is malformed.'); }
  return receipt;
}

async function runRecoveryProbe(baseline, { targetBaseline = baseline, mode = 'fresh' } = {}) {
  const toolRevision = sourceIdentity();
  const ordinary = (name, maximum) => readBoundedFileSync(path.join(baseline.directory, name), maximum);
  const archive = ordinary('synthetic-backup.zip', 16 * 1024 * 1024);
  const original = ordinary('original-flow.json', 1024 * 1024);
  const expected = validateRecoveryInput(baseline.receipt, archive, original, toolRevision);
  const baselineReceipt = ordinary('receipt.json', 1024 * 1024);
  const baselineChecksum = ordinary('receipt.sha256', 1024).toString('utf8').match(/^([a-f0-9]{64})  receipt\.json\r?\n$/)?.[1];
  if (digest(baselineReceipt) !== baselineChecksum
      || JSON.stringify(JSON.parse(baselineReceipt)) !== JSON.stringify(baseline.receipt)) {
    throw new Error('Retained baseline receipt differs from the completed baseline result.');
  }
  const broaderState = baseline.receipt.syntheticState !== undefined;
  const stateBytes = broaderState ? ordinary('original-state.json', 1024 * 1024) : undefined;
  const expectedState = broaderState ? validateSyntheticStateReceipt(baseline.receipt, stateBytes) : undefined;
  const flowBytes = broaderState ? ordinary('original-flows.json', 1024 * 1024) : undefined;
  const initialFlowBytes = broaderState ? ordinary('initial-flows.json', 1024 * 1024) : undefined;
  const inventory = broaderState ? validateFlowInventoryReceipt(baseline.receipt, flowBytes, initialFlowBytes) : undefined;
  const expectedFlows = inventory?.original;
  let targetInitialFlows = inventory?.initial;
  let targetReceiptSha256 = digest(baselineReceipt);
  if (targetBaseline !== baseline) {
    validateRecoveryTarget(targetBaseline.receipt, toolRevision);
    validateRecoveryTarget(baseline.receipt, toolRevision);
    const bytes = readBoundedFileSync(path.join(targetBaseline.directory, 'receipt.json'), 1024 * 1024);
    const checksum = readBoundedFileSync(path.join(targetBaseline.directory, 'receipt.sha256'), 1024)
      .toString('utf8').match(/^([a-f0-9]{64})  receipt\.json\r?\n$/)?.[1];
    if (digest(bytes) !== checksum || JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(targetBaseline.receipt)) {
      throw new Error('Candidate consumer receipt differs from its retained result.');
    }
    const manifest = JSON.parse(readBoundedFileSync(path.join(targetBaseline.directory, 'consumer/node_modules/flujo-ai/package.json'), 1024 * 1024));
    const lock = readBoundedFileSync(path.join(targetBaseline.directory, 'consumer/package-lock.json'), 20 * 1024 * 1024);
    if (manifest.name !== 'flujo-ai' || manifest.version !== targetBaseline.receipt.version
        || digest(lock) !== targetBaseline.receipt.consumerLockSha256) throw new Error('Candidate consumer identity or lock differs from its successful probe.');
    targetReceiptSha256 = digest(bytes);
    if (broaderState) {
      validateSyntheticStateReceipt(targetBaseline.receipt,
        readBoundedFileSync(path.join(targetBaseline.directory, 'original-state.json'), 1024 * 1024));
      targetInitialFlows = validateFlowInventoryReceipt(targetBaseline.receipt,
        readBoundedFileSync(path.join(targetBaseline.directory, 'original-flows.json'), 1024 * 1024),
        readBoundedFileSync(path.join(targetBaseline.directory, 'initial-flows.json'), 1024 * 1024)).initial;
    }
  }
  const JSZip = createRequire(import.meta.url)('jszip');
  if (broaderState) await verifySyntheticStateArchive(archive, JSZip, expectedState, expectedFlows);
  const directory = path.join(baseline.directory, mode === 'upgrade' ? 'candidate-upgrade' : 'fresh-recovery');
  // Evidence roots must be new; upgrade data comes only from the stopped baseline.
  mkdirSync(directory);
  for (const name of ['data', 'home', 'tmp', 'roots']) mkdirSync(path.join(directory, name));
  const dataRoot = mode === 'upgrade' ? path.join(baseline.directory, 'data') : path.join(directory, 'data');
  const env = { ...drillEnvironment(process.env, directory), NODE_ENV: 'production', FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_DATA_DIR: dataRoot,
    FLUJO_FS_ROOTS: path.join(directory, 'roots'), FLUJO_BASH_ROOTS: path.join(directory, 'roots') };
  const appRoot = path.join(targetBaseline.directory, 'consumer', 'node_modules', 'flujo-ai');
  const receipt = { schemaVersion: 1, kind: mode === 'upgrade' ? 'automated-installed-version-upgrade' : 'automated-installed-fresh-recovery', result: 'failed',
    startedAt: new Date().toISOString(), toolRevision, toolScriptSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    sourceCleanBefore: true, sourceCleanAfter: null, version: targetBaseline.receipt.version,
    restoredFromVersion: baseline.receipt.version, operation: mode,
    declaredArtifactSourceRevision: targetBaseline.receipt.declaredArtifactSourceRevision,
    integrity: targetBaseline.receipt.integrity, baselineReceiptSha256: digest(baselineReceipt), targetReceiptSha256,
    backupSha256: digest(archive), platform: process.platform, arch: process.arch, node: process.version,
    baselineDirectory: baseline.directory, targetConsumerDirectory: targetBaseline.directory, dataRoot, directory, commands: [], observations: [], shutdowns: [], evidence: [],
    pending: ['qualified-integrated-candidate-version-upgrade', 'independent-human-review', 'human-operated-drill',
      'private-triage-tabletop', 'verified-backup-access', '90-day-observation', 'independent-reassessment'],
    limits: [targetBaseline === baseline ? 'Published baseline only; same artifact reused for fresh-root recovery and restart'
      : 'Two pinned consumers; candidate qualification is recorded by the version-transition orchestrator separately',
      broaderState ? 'Observed public seed inventory plus synthetic flow/conversation/theme/non-secret variable; no provider/model, identity/secrets, schedule or Persona recovery'
        : 'Legacy synthetic empty flow only; no broader state, provider/model, identity/secrets, schedule or Persona recovery',
      broaderState ? 'Signature result is linked from the verified baseline; no every-descendant/graceful-cleanup certification'
        : 'Legacy input does not establish provenance signatures or every-descendant/graceful-cleanup certification'],
  };
  const files = new Set(); let owned; let baseUrl;
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort(new Error('Operator interrupted recovery.'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  function capture(name, bytes) {
    writeFileSync(path.join(directory, name), bytes, { flag: 'wx' }); files.add(name);
  }
  async function request(route, options = {}) {
    const started = Date.now();
    const response = await fetch(new URL(route, baseUrl), { ...options, redirect: 'error',
      signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15000)]) });
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length; if (length > 16 * 1024 * 1024) throw new Error('Recovery response exceeds 16 MiB.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks); const filename = `response-${String(receipt.observations.length + 1).padStart(3, '0')}.bin`;
    capture(filename, bytes);
    receipt.observations.push({ route, method: options.method ?? 'GET', status: response.status,
      elapsedMs: Date.now() - started, body: filename, sha256: digest(bytes), bytes: bytes.length });
    return { status: response.status, bytes };
  }
  async function start(name) {
    const port = await reservePort(); baseUrl = `http://127.0.0.1:${port}`;
    const args = [path.join(appRoot, 'bin', 'flujo.mjs'), '--no-open', '--port', String(port)];
    const stdout = `${name}.stdout.txt`; const stderr = `${name}.stderr.txt`;
    const fds = [openSync(path.join(directory, stdout), 'wx'), openSync(path.join(directory, stderr), 'wx')];
    files.add(stdout); files.add(stderr);
    let child;
    try { child = spawn(process.execPath, args, { cwd: appRoot, env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', ...fds] }); }
    finally { for (const fd of fds) closeSync(fd); }
    const record = { name, command: [process.execPath, ...args], cwd: appRoot, pid: child.pid,
      startedAt: new Date().toISOString(), port, exit: null };
    receipt.commands.push(record);
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => {
        record.exit = { code, signal, observedAt: new Date().toISOString() }; resolve(record.exit);
      });
    });
    exited.catch(error => { record.launchFailure = error.message; });
    owned = { child, exited, record };
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      interrupted.signal.throwIfAborted();
      if (record.exit || record.launchFailure) throw new Error('Recovery launcher exited/failed before readiness.');
      let identity;
      try { const result = await request('/api/cwd'); if (result.status === 200) identity = JSON.parse(result.bytes); }
      catch { /* Readiness retry has no mutation. */ }
      if (identity) { assertInstalledIdentity(identity, appRoot, dataRoot); return; }
      await delay(300);
    }
    throw new Error(mode === 'upgrade' ? 'Candidate upgrade never became ready.' : 'Fresh recovery never became ready.');
  }
  async function stop() {
    if (!owned) return;
    const current = owned; const shutdown = { name: current.record.name, pid: current.child.pid, mode: 'already-exited' };
    receipt.shutdowns.push(shutdown);
    if (current.child.pid && process.platform === 'win32' && current.child.exitCode === null && current.child.signalCode === null) {
      shutdown.mode = 'forced-owned-process-tree';
      shutdown.taskkill = await bounded(new Promise((resolve, reject) => {
        const killer = spawn('taskkill', ['/PID', String(current.child.pid), '/T', '/F'], { windowsHide: true });
        let output = ''; killer.stdout.on('data', bytes => { output += bytes; }); killer.stderr.on('data', bytes => { output += bytes; });
        killer.once('error', reject); killer.once('close', code => resolve({ code, output }));
      }), 30000, 'Recovery process cleanup timed out.');
      if (shutdown.taskkill.code !== 0) throw new Error('Recovery process cleanup failed.');
    } else if (current.child.pid && process.platform !== 'win32') {
      shutdown.mode = 'SIGTERM-owned-process-group';
      try { process.kill(-current.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    try { await bounded(current.exited, 15000, 'Recovery launcher did not exit.'); }
    catch (error) {
      if (current.child.pid && process.platform !== 'win32') {
        try { process.kill(-current.child.pid, 'SIGKILL'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
        await bounded(current.exited, 5000, 'Recovery launcher did not exit after SIGKILL.');
      }
      throw error;
    }
    shutdown.launcherExit = current.record.exit;
    const deadline = Date.now() + 5000;
    while (await portOpen(current.record.port)) {
      if (Date.now() >= deadline) throw new Error('Recovery loopback port remains reachable after cleanup.');
      await delay(200);
    }
    shutdown.loopbackPortClosed = true; owned = undefined;
  }
  try {
    capture('original-flow.json', original); capture('input-backup.zip', archive);
    if (broaderState) {
      capture('original-state.json', stateBytes);
      receipt.syntheticState = { schemaVersion: 1, original: 'original-state.json', selections: [...stateSelections], verified: false };
      capture('original-flows.json', flowBytes); capture('initial-flows.json', initialFlowBytes);
      receipt.flowInventory = { schemaVersion: 1, original: 'original-flows.json', initial: 'initial-flows.json',
        ids: canonicalFlowInventory(expectedFlows).map(flow => flow.id), ignoredFields: ['createdAt', 'updatedAt'],
        archiveIncludesAllFlows: true, verified: false };
    }
    await start(mode === 'upgrade' ? 'upgrade-start' : 'fresh-start');
    const route = `/api/flow/${expected.id}`;
    const before = await request(route);
    if (mode === 'upgrade') {
      if (before.status !== 200) throw new Error('Candidate did not preserve the existing baseline flow before any restore.');
      assertRestoredFlow(JSON.parse(before.bytes), expected); capture('pre-upgrade-flow.json', before.bytes);
      if (broaderState) {
        const existingState = await readSyntheticState(request); assertSyntheticState(existingState, expectedState);
        capture('pre-upgrade-state.json', JSON.stringify(existingState, null, 2) + '\n'); receipt.baselineStateFoundBeforeRestore = true;
        const existingFlows = await readFlowInventory(request); assertFlowInventory(existingFlows, expectedFlows);
        capture('pre-upgrade-flows.json', JSON.stringify(existingFlows, null, 2) + '\n'); receipt.baselineFlowsFoundBeforeRestore = true;
      }
      receipt.baselineDataFoundBeforeRestore = true;
    } else {
      if (before.status !== 404) throw new Error('Fresh root already contains the synthetic flow.');
      receipt.preRestoreAbsent = true;
      if (broaderState) {
        await assertFreshSyntheticState(request); receipt.preRestoreStateAbsent = true;
        const freshFlows = await readFlowInventory(request, false); assertFlowInventory(freshFlows, targetInitialFlows, false);
        capture('pre-restore-flows.json', JSON.stringify(freshFlows, null, 2) + '\n'); receipt.preRestoreFlowInventoryVerified = true;
      }
    }
    const restore = bytes => {
      const form = new FormData(); form.set('file', new Blob([bytes]), 'synthetic-backup.zip'); form.set('selections', '["flows"]');
      return request('/api/restore', { method: 'POST', body: form });
    };
    const invalidZip = new JSZip(); invalidZip.file('storage/flows.json', JSON.stringify([expected]));
    const invalids = broaderState ? await invalidSyntheticStateArchives(archive, JSZip)
      : [{ name: 'missing-metadata.zip', bytes: await invalidZip.generateAsync({ type: 'nodebuffer' }) }];
    receipt.invalidRestoreCases = [];
    for (const invalid of invalids) {
      capture(invalid.name, invalid.bytes);
      const invalidResult = broaderState ? await restoreSyntheticState(request, invalid.bytes) : await restore(invalid.bytes);
      const unchanged = await request(route);
      if (invalidResult.status !== 400 || unchanged.status !== (mode === 'upgrade' ? 200 : 404)) {
        throw new Error('Invalid archive was accepted or changed the recovery root.');
      }
      if (mode === 'upgrade') {
        assertRestoredFlow(JSON.parse(unchanged.bytes), expected);
        if (broaderState) {
          assertSyntheticState(await readSyntheticState(request), expectedState);
          assertFlowInventory(await readFlowInventory(request), expectedFlows);
        }
      } else if (broaderState) {
        await assertFreshSyntheticState(request);
        assertFlowInventory(await readFlowInventory(request, false), targetInitialFlows, false);
      }
      receipt.invalidRestoreCases.push({ archive: invalid.name, status: 400, flowAndStateUnchanged: true });
    }
    receipt.invalidRestoreUnchanged = true;
    if (mode === 'fresh' && (broaderState ? await restoreSyntheticState(request, archive) : await restore(archive)).status !== 200) throw new Error('Fresh-root restore failed.');
    const restored = await request(route);
    if (restored.status !== 200) throw new Error('Restored fresh-root flow was not readable.');
    assertRestoredFlow(JSON.parse(restored.bytes), expected); capture(mode === 'upgrade' ? 'upgraded-flow.json' : 'restored-flow.json', restored.bytes);
    if (broaderState) {
      const state = await readSyntheticState(request); assertSyntheticState(state, expectedState);
      capture(mode === 'upgrade' ? 'upgraded-state.json' : 'restored-state.json', JSON.stringify(state, null, 2) + '\n');
      const flows = await readFlowInventory(request); assertFlowInventory(flows, expectedFlows);
      capture(mode === 'upgrade' ? 'upgraded-flows.json' : 'restored-flows.json', JSON.stringify(flows, null, 2) + '\n');
    }
    const exported = await request('/api/backup', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selections: broaderState ? stateSelections : ['flows'] }) });
    if (exported.status !== 200) throw new Error('Recovered data could not be backed up again.');
    capture('recovered-backup.zip', exported.bytes);
    if (broaderState) {
      receipt.syntheticState.archiveVerified = await verifySyntheticStateArchive(exported.bytes, JSZip, expectedState, expectedFlows);
      receipt.flowInventory.reexportSha256 = digest(exported.bytes);
    }
    else {
      const zip = await JSZip.loadAsync(exported.bytes);
      if (!zip.file('backup-info.json') || !zip.file('storage/flows.json')) throw new Error('Recovered backup omitted expected metadata/content.');
      const flows = JSON.parse(await zip.file('storage/flows.json').async('string'));
      const recovered = flows.find(flow => flow.id === expected.id);
      if (!recovered) throw new Error('Recovered backup omitted synthetic flow.');
      assertRestoredFlow(recovered, expected);
    }
    receipt.roundtripBackupVerified = true;
    await stop(); await start('restart');
    const reopened = await request(route);
    if (reopened.status !== 200) throw new Error('Recovered flow did not survive restart.');
    assertRestoredFlow(JSON.parse(reopened.bytes), expected); capture('restarted-flow.json', reopened.bytes);
    if (broaderState) {
      const state = await readSyntheticState(request); assertSyntheticState(state, expectedState);
      capture('restarted-state.json', JSON.stringify(state, null, 2) + '\n'); receipt.syntheticState.verified = true;
      const flows = await readFlowInventory(request); assertFlowInventory(flows, expectedFlows);
      capture('restarted-flows.json', JSON.stringify(flows, null, 2) + '\n'); receipt.flowInventory.verified = true;
    }
    receipt.restartPersistenceVerified = true;
    receipt.semanticComparison = { fields: ['id', 'name', 'nodes', 'edges'], passed: true, timestamps: 'Retained; not stable content' };
    receipt.result = mode === 'upgrade' ? 'passed-version-upgrade' : 'passed-fresh-recovery';
  } catch (error) { receipt.failure = error.message; }
  finally {
    try { await stop(); } catch (error) { receipt.result = 'failed'; receipt.shutdownFailure = error.message; }
    try {
      receipt.sourceCleanAfter = sourceIdentity() === toolRevision;
      if (!receipt.sourceCleanAfter) throw new Error('Recovery tool source changed.');
    } catch (error) { receipt.sourceCleanAfter = false; receipt.result = 'failed'; receipt.sourceFailure = error.message; }
    for (const name of [...files].sort()) {
      const bytes = readFileSync(path.join(directory, name)); receipt.evidence.push({ path: name, sha256: digest(bytes), bytes: bytes.length });
    }
    receipt.completedAt = new Date().toISOString(); const bytes = JSON.stringify(receipt, null, 2) + '\n';
    capture('receipt.json', bytes); capture('receipt.sha256', `${digest(bytes)}  receipt.json\n`);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  return { directory, receipt };
}

export function recoverIntoFreshRoot(baseline, targetBaseline = baseline) {
  return runRecoveryProbe(baseline, { targetBaseline, mode: 'fresh' });
}

export function upgradeExistingRoot(baseline, targetBaseline) {
  const parts = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    ? value.split('.').map(Number) : [];
  const before = parts(baseline?.receipt?.version); const after = parts(targetBaseline?.receipt?.version);
  const difference = after.findIndex((value, index) => value !== before[index]);
  if (before.length !== 3 || after.length !== 3 || ![...before, ...after].every(Number.isSafeInteger)
      || difference < 0 || after[difference] < before[difference]) {
    throw new Error('Version upgrade requires a greater candidate version.');
  }
  return runRecoveryProbe(baseline, { targetBaseline, mode: 'upgrade' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
    else {
      const baseline = await runInstalledBaseline(parseBaselineOptions(process.argv.slice(2)));
      if (baseline.receipt.result !== 'passed-baseline-probe') {
        console.log(JSON.stringify({ result: 'failed-baseline', directory: baseline.directory, failure: baseline.receipt.failure }));
        process.exitCode = 1;
      } else {
        const result = await recoverIntoFreshRoot(baseline);
        console.log(JSON.stringify({ result: result.receipt.result, directory: result.directory,
          baselineDirectory: baseline.directory, failure: result.receipt.failure, shutdownFailure: result.receipt.shutdownFailure }));
        if (result.receipt.result !== 'passed-fresh-recovery') process.exitCode = 1;
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
