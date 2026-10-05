import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drillEnvironment } from './maintainer-drill.mjs';
import { fetchNpmProvenance, verifyNpmProvenance } from './maintainer-npm-provenance.mjs';
import { stateSelections, seedSyntheticState, syntheticState, readSyntheticState, assertSyntheticState,
  mutateSyntheticState, readFlowInventory, canonicalFlowInventory, assertFlowInventory,
  verifySyntheticStateArchive, restoreSyntheticState, invalidSyntheticStateArchives } from './maintainer-synthetic-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const usage = 'Usage: node scripts/maintainer-installed-baseline.mjs --version=VERSION '
  + '--integrity=SHA512_SRI --source-revision=SHA [--npm-cli=ABSOLUTE_NPM_CLI_JS]';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function parseBaselineOptions(args) {
  const options = {};
  for (const arg of args) {
    const match = /^--(version|integrity|source-revision|npm-cli)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error(usage);
    options[match[1]] = match[2];
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.version ?? '')
      || !/^[a-f0-9]{40}$/.test(options['source-revision'] ?? '')) throw new Error(usage);
  const encoded = options.integrity?.match(/^sha512-([A-Za-z0-9+/]{86}==)$/)?.[1];
  if (!encoded || Buffer.from(encoded, 'base64').length !== 64
      || Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw new Error(usage);
  if (options['npm-cli'] && (!path.isAbsolute(options['npm-cli'])
      || path.basename(options['npm-cli']) !== 'npm-cli.js')) throw new Error(usage);
  return { version: options.version, integrity: options.integrity,
    artifactSourceRevision: options['source-revision'], npmCli: options['npm-cli'] };
}

export function assertInstalledIdentity(observed, appRoot, dataRoot) {
  if (typeof observed.cwd !== 'string' || typeof observed.mcpServersDir !== 'string'
      || path.resolve(observed.cwd) !== path.resolve(appRoot)) {
    throw new Error('Readiness belongs to a different installed process; no mutation allowed.');
  }
  const relative = path.relative(path.resolve(dataRoot), path.resolve(observed.mcpServersDir));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Readiness belongs to a different data root; no mutation allowed.');
  }
}

export function assertRestoredFlow(observed, expected) {
  for (const field of ['id', 'name', 'nodes', 'edges']) {
    if (JSON.stringify(observed[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`Restored ${field} differs from the synthetic fixture.`);
    }
  }
}

function cleanRevision() {
  const git = args => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
  }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision) || git(['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Start from a clean committed checkout to bind the tool to an exact revision.');
  }
  return revision;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function listening(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}

export async function runInstalledBaseline(options) {
  options = parseBaselineOptions([`--version=${options.version}`, `--integrity=${options.integrity}`,
    `--source-revision=${options.artifactSourceRevision}`].concat(options.npmCli ? [`--npm-cli=${options.npmCli}`] : []));
  // Resolve dependencies and npm before network access or creating any processes.
  const JSZip = createRequire(import.meta.url)('jszip');
  const toolRevision = cleanRevision();
  const npmCli = options.npmCli ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('npm CLI not found beside Node. Supply --npm-cli=ABSOLUTE_NPM_CLI_JS.');
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'flujo-maintainer-installed-'));
  for (const name of ['home', 'tmp', 'data', 'roots', 'consumer', 'cache']) await mkdir(path.join(sandbox, name));
  const env = { ...drillEnvironment(process.env, sandbox), NODE_ENV: 'production',
    npm_config_cache: path.join(sandbox, 'cache'),
    FLUJO_FS_ROOTS: path.join(sandbox, 'roots'), FLUJO_BASH_ROOTS: path.join(sandbox, 'roots') };
  const receipt = { schemaVersion: 1, kind: 'automated-installed-baseline-probe',
    startedAt: new Date().toISOString(), version: options.version, integrity: options.integrity,
    declaredArtifactSourceRevision: options.artifactSourceRevision,
    artifactSourceVerification: 'Pending pinned npm provenance verification before consumer installation',
    provenanceSignatureVerified: false, provenanceCommands: [],
    toolRevision, toolScriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    sourceCleanBefore: true, sourceCleanAfter: null, sandbox, platform: process.platform,
    arch: process.arch, node: process.version, commands: [], observations: [], evidence: [], result: 'failed',
    pending: ['independent-human-review', 'human-operated-drill', 'private-triage-tabletop',
      'qualified-candidate-upgrade-recovery', 'verified-backup-access', '90-day-observation', 'independent-reassessment'],
    limits: ['Published baseline only; no version upgrade or integrated candidate acceptance',
      'Observed public seed inventory plus synthetic flow/conversation/theme/non-secret variable; no provider/model call, identity/secrets, Persona or schedules',
      'Fresh consumer transitive dependencies resolve now; retained lock records this graph',
      'Shutdown observations do not certify every descendant generation or graceful application cleanup'],
  };
  let app;
  let port;
  let baseUrl;
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort(new Error('Operator interrupted the probe.'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  function abortable(promise) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(interrupted.signal.reason);
      interrupted.signal.addEventListener('abort', abort, { once: true });
      if (interrupted.signal.aborted) abort();
      promise.then(resolve, reject).finally(() => interrupted.signal.removeEventListener('abort', abort));
    });
  }
  const files = new Set();
  async function capture(name, bytes) {
    await writeFile(path.join(sandbox, name), bytes, { flag: 'wx' }); files.add(name);
  }
  function launch(name, args, cwd) {
    const stdout = `${name}.stdout.txt`; const stderr = `${name}.stderr.txt`;
    const fds = [openSync(path.join(sandbox, stdout), 'wx'), openSync(path.join(sandbox, stderr), 'wx')];
    files.add(stdout); files.add(stderr);
    let child;
    try {
      child = spawn(process.execPath, args, { cwd, env, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', ...fds] });
    } finally { for (const fd of fds) closeSync(fd); }
    const record = { name, command: [process.execPath, ...args], cwd, pid: child.pid,
      startedAt: new Date().toISOString(), exit: null };
    receipt.commands.push(record);
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        record.exit = { code, signal, observedAt: new Date().toISOString() }; resolve(record.exit);
      });
    });
    // A launch error is also inspected by the awaited operation/readiness check.
    exited.catch(error => { record.launchFailure = error.message; });
    return { child, exited, record };
  }
  async function stopOwned(owned) {
    if (!owned) return;
    const child = owned.child;
    const shutdown = { pid: child.pid, mode: 'already-exited', launcherExit: owned.record.exit };
    if (child.pid && process.platform === 'win32' && child.exitCode === null && child.signalCode === null) {
      shutdown.mode = 'forced-owned-process-tree';
      const result = await withTimeout(new Promise((resolve, reject) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        let output = ''; killer.stdout.on('data', bytes => { output += bytes; });
        killer.stderr.on('data', bytes => { output += bytes; });
        killer.once('error', reject); killer.once('close', code => resolve({ code, output }));
      }), 30000, 'Owned Windows process cleanup timed out.');
      shutdown.taskkill = result;
      if (result.code !== 0) throw new Error(`Owned process cleanup returned ${result.code}.`);
    } else if (child.pid && process.platform !== 'win32') {
      shutdown.mode = 'SIGTERM-owned-process-group';
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    try { await withTimeout(owned.exited, 15000, 'Owned launcher did not exit.'); }
    catch (error) {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
        await withTimeout(owned.exited, 5000, 'Owned launcher did not exit after SIGKILL.');
      }
      throw error;
    }
    shutdown.launcherExit = owned.record.exit;
    return shutdown;
  }
  async function request(route, requestOptions = {}) {
    const response = await fetch(new URL(route, baseUrl), { ...requestOptions,
      redirect: 'error', signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15000)]) });
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 16 * 1024 * 1024) throw new Error('Synthetic API response exceeds 16 MiB.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const name = `response-${String(receipt.observations.length + 1).padStart(3, '0')}.bin`;
    await capture(name, bytes);
    receipt.observations.push({ route, method: requestOptions.method ?? 'GET', status: response.status,
      body: name, bytes: bytes.length, sha256: sha256(bytes) });
    return { status: response.status, bytes };
  }
  const flow = { id: 'maintainer_drill_flow', name: 'Synthetic maintainer recovery fixture', nodes: [], edges: [] };
  try {
    const archiveName = `flujo-ai-${options.version}.tgz`;
    const archive = path.join(sandbox, archiveName); files.add(archiveName);
    const url = `https://registry.npmjs.org/flujo-ai/-/${archiveName}`;
    const response = await fetch(url, { redirect: 'error',
      signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(120000)]) });
    if (!response.ok) throw new Error(`Tarball read returned ${response.status}.`);
    let compressedBytes = 0; const hash = createHash('sha512');
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > 512 * 1024 * 1024) return callback(new Error('Package exceeds 512 MiB download limit.'));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(archive, { flags: 'wx' }));
    const integrity = `sha512-${hash.digest('base64')}`;
    receipt.tarball = { url, compressedBytes, observedIntegrity: integrity };
    if (integrity !== options.integrity) throw new Error('Published tarball integrity mismatch; no install allowed.');
    const provenance = await fetchNpmProvenance(options, { directory: sandbox, capture, signal: interrupted.signal });
    const runVerifier = (command, args) => {
      const record = { command, args, startedAt: new Date().toISOString(), code: null };
      receipt.provenanceCommands.push(record);
      try {
        const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
        record.code = result.status; record.signal = result.signal;
        record.stdout = result.stdout ?? ''; record.stderr = result.stderr ?? '';
        if (result.error) { record.launchFailure = result.error.message; throw result.error; }
        if (result.status !== 0 || result.signal) throw new Error(`Npm provenance verifier exited ${result.signal ?? result.status}; no install allowed.`);
        return record.stdout;
      } finally { record.completedAt = new Date().toISOString(); }
    };
    try {
      receipt.npmProvenance = { ...verifyNpmProvenance(options, { archive, bundlePath: provenance.bundlePath }, runVerifier),
        metadataUrl: provenance.metadataUrl, attestationsUrl: provenance.attestationsUrl };
      receipt.provenanceSignatureVerified = true;
      receipt.artifactSourceVerification = 'Verified Sigstore signature and pinned official publish workflow, main source, hosted runner and SHA-512 package subject';
    } finally {
      for (const [index, command] of receipt.provenanceCommands.entries()) {
        const prefix = `provenance-${index + 1}`;
        await capture(`${prefix}.stdout.json`, command.stdout ?? '');
        await capture(`${prefix}.stderr.txt`, command.stderr ?? '');
        command.stdout = `${prefix}.stdout.json`; command.stderr = `${prefix}.stderr.txt`;
      }
    }
    await capture('consumer/package.json', '{"private":true}\n');
    await capture('empty-user.npmrc', ''); await capture('empty-global.npmrc', '');
    const consumer = path.join(sandbox, 'consumer');
    const install = launch('install', [npmCli, 'install', archive, '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org', `--userconfig=${path.join(sandbox, 'empty-user.npmrc')}`,
      `--globalconfig=${path.join(sandbox, 'empty-global.npmrc')}`], consumer);
    try {
      const result = await abortable(withTimeout(install.exited, 600000, 'Consumer install timed out.'));
      if (result.code !== 0 || result.signal) throw new Error(`Consumer install exited ${result.signal ?? result.code}.`);
    } finally { receipt.installCleanup = await stopOwned(install); }
    files.add('consumer/package-lock.json');
    const appRoot = path.join(consumer, 'node_modules', 'flujo-ai');
    const manifest = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
    if (manifest.name !== 'flujo-ai' || manifest.version !== options.version) throw new Error('Installed manifest differs from pin.');
    receipt.installedManifest = { name: manifest.name, version: manifest.version };
    receipt.consumerLockSha256 = sha256(await readFile(path.join(consumer, 'package-lock.json')));
    port = await unusedPort(); baseUrl = `http://127.0.0.1:${port}`; receipt.baseUrl = baseUrl;
    app = launch('app', [path.join(appRoot, 'bin', 'flujo.mjs'), '--no-open', '--port', String(port)], appRoot);
    const deadline = Date.now() + 90000;
    let ready = false;
    while (Date.now() < deadline) {
      interrupted.signal.throwIfAborted();
      if (app.record.exit || app.record.launchFailure) throw new Error('Installed CLI exited/failed before readiness.');
      let identity;
      try {
        const result = await request('/api/cwd');
        if (result.status === 200) identity = JSON.parse(result.bytes);
      } catch { /* Connection not ready; no mutation performed. */ }
      if (identity) {
        assertInstalledIdentity(identity, appRoot, path.join(sandbox, 'data'));
        receipt.observedIdentity = identity; ready = true; break;
      }
      await delay(300);
    }
    if (!ready) throw new Error('Installed baseline never became ready.');
    const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const initialFlows = await readFlowInventory(request, false);
    await capture('initial-flows.json', JSON.stringify(initialFlows, null, 2) + '\n');
    if ((await request('/api/flow', { method: 'POST', ...json(flow) })).status !== 201) throw new Error('Synthetic flow creation failed.');
    const original = await request(`/api/flow/${flow.id}`);
    if (original.status !== 200) throw new Error('Created flow was not readable.');
    await capture('original-flow.json', original.bytes);
    assertRestoredFlow(JSON.parse(original.bytes), flow);
    receipt.syntheticState = { schemaVersion: 1, original: 'original-state.json', verified: false,
      selections: [...stateSelections], unsupported: ['provider/model configuration', 'identity/secrets', 'Persona state', 'schedule continuity'] };
    await seedSyntheticState(request, capture, JSZip);
    const originalFlows = await readFlowInventory(request);
    assertFlowInventory(originalFlows.filter(item => item.id !== flow.id), initialFlows, false);
    await capture('original-flows.json', JSON.stringify(originalFlows, null, 2) + '\n');
    receipt.flowInventory = { schemaVersion: 1, original: 'original-flows.json', initial: 'initial-flows.json',
      ids: canonicalFlowInventory(originalFlows).map(item => item.id), ignoredFields: ['createdAt', 'updatedAt'],
      verified: false, archiveIncludesAllFlows: false };
    const backup = await request('/api/backup', { method: 'POST', ...json({ selections: stateSelections }) });
    if (backup.status !== 200) throw new Error('Synthetic backup failed.');
    await capture('exported-backup.zip', backup.bytes);
    const backupBytes = backup.bytes;
    const archived = await verifySyntheticStateArchive(backupBytes, JSZip, syntheticState(), originalFlows);
    await capture('synthetic-backup.zip', backupBytes);
    receipt.backup = { sha256: sha256(backupBytes), bytes: backupBytes.length, entries: archived.entries,
      exportedSha256: sha256(backup.bytes), exportedBytes: backup.bytes.length, flowIds: archived.flowInventory.ids };
    receipt.flowInventory.archiveIncludesAllFlows = true;
    const mutated = { ...JSON.parse(original.bytes), name: 'Deliberately changed inside disposable root' };
    const mutatedFlows = originalFlows.map(item => item.id === flow.id ? { ...item, name: mutated.name } : item);
    if ((await request(`/api/flow/${flow.id}`, { method: 'PUT', ...json(mutated) })).status !== 200) throw new Error('Disposable fault injection failed.');
    await mutateSyntheticState(request); receipt.invalidRestoreCases = [];
    for (const invalid of await invalidSyntheticStateArchives(backupBytes, JSZip)) {
      await capture(invalid.name, invalid.bytes);
      if ((await restoreSyntheticState(request, invalid.bytes)).status !== 400) throw new Error(`Invalid ${invalid.name} was not rejected with 400.`);
      const rejectedState = await request(`/api/flow/${flow.id}`);
      if (rejectedState.status !== 200) throw new Error('Flow unreadable after rejected restore.');
      assertRestoredFlow(JSON.parse(rejectedState.bytes), mutated);
      assertFlowInventory(await readFlowInventory(request), mutatedFlows);
      assertSyntheticState(await readSyntheticState(request), syntheticState(true));
      receipt.invalidRestoreCases.push({ archive: invalid.name, status: 400, flowAndStateUnchanged: true });
    }
    if ((await restoreSyntheticState(request, backupBytes)).status !== 200) throw new Error('Valid backup restore failed.');
    const final = await request(`/api/flow/${flow.id}`);
    if (final.status !== 200) throw new Error('Restored flow was not readable.');
    await capture('restored-flow.json', final.bytes); assertRestoredFlow(JSON.parse(final.bytes), flow);
    const restoredState = await readSyntheticState(request); assertSyntheticState(restoredState);
    await capture('restored-state.json', JSON.stringify(restoredState, null, 2) + '\n');
    const restoredFlows = await readFlowInventory(request); assertFlowInventory(restoredFlows, originalFlows);
    await capture('restored-flows.json', JSON.stringify(restoredFlows, null, 2) + '\n');
    const reexported = await request('/api/backup', { method: 'POST', ...json({ selections: stateSelections }) });
    if (reexported.status !== 200) throw new Error('Restored inventory could not be backed up again.');
    await capture('restored-backup.zip', reexported.bytes);
    receipt.flowInventory.restoredArchiveVerified = await verifySyntheticStateArchive(reexported.bytes, JSZip, syntheticState(), originalFlows);
    receipt.flowInventory.verified = true;
    receipt.syntheticState.verified = true;
    receipt.syntheticState.archiveVerified = archived;
    receipt.semanticComparison = { fields: ['id', 'name', 'nodes', 'edges'], passed: true,
      serverTimestamps: 'Retained separately; not compared as stable content' };
    receipt.result = 'passed-baseline-probe';
  } catch (error) { receipt.failure = error.message; }
  finally {
    try {
      receipt.shutdown = await stopOwned(app);
      if (port) {
        const deadline = Date.now() + 5000;
        while (await listening(port)) {
          if (Date.now() >= deadline) throw new Error('Loopback port remains reachable after owned launcher cleanup.');
          await delay(200);
        }
        receipt.shutdown.loopbackPortClosed = true;
      }
    } catch (error) { receipt.result = 'failed'; receipt.shutdownFailure = error.message; }
    try {
      receipt.sourceCleanAfter = cleanRevision() === toolRevision;
      if (!receipt.sourceCleanAfter) throw new Error('Tool revision changed during the probe.');
    } catch (error) { receipt.sourceCleanAfter = false; receipt.result = 'failed'; receipt.sourceFailure = error.message; }
    for (const name of [...files].sort()) {
      try { const bytes = await readFile(path.join(sandbox, name)); receipt.evidence.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
      catch (error) { receipt.evidence.push({ path: name, unavailable: error.code ?? error.message }); }
    }
    receipt.completedAt = new Date().toISOString();
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    await capture('receipt.json', bytes); await capture('receipt.sha256', `${sha256(bytes)}  receipt.json\n`);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  return { directory: sandbox, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
    else {
      const result = await runInstalledBaseline(parseBaselineOptions(process.argv.slice(2)));
      console.log(JSON.stringify({ result: result.receipt.result, directory: result.directory,
        failure: result.receipt.failure, shutdownFailure: result.receipt.shutdownFailure }));
      if (result.receipt.result !== 'passed-baseline-probe') process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
