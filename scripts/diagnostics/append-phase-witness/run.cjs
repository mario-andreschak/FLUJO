'use strict';
// PREPARED ONLY. Entry requires a separately assigned Linux diagnostic window.
// Never install, alter a production file, rerun the original 20k test, or bypass
// admission. This driver writes one temporary fixture and new external receipts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const packet = __dirname;
const arg = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const demand = (condition, message) => { if (!condition) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = (executable, args, cwd) => execFileSync(executable, args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }).trim();
function birth(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), ppid: Number(fields[1]), pgrp: Number(fields[2]), state: fields[0], startTicks: fields[19] };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
function ownedProcesses(leader, records) {
  if (!leader) return [];
  const processes = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(birth).filter(Boolean);
  const known = processes.filter(item => [...records.values()].some(record => record.pid === item.pid && record.startTicks === item.startTicks));
  const leaderAlive = processes.some(item => item.pid === leader.pid && item.startTicks === leader.startTicks);
  const groupStillOwned = leaderAlive || known.some(item => item.pgrp === leader.pid);
  const included = new Set(known.map(item => item.pid));
  if (leaderAlive) included.add(leader.pid);
  let changed = true;
  while (changed) { changed = false; for (const item of processes) if (!included.has(item.pid) && (included.has(item.ppid) || (groupStillOwned && item.pgrp === leader.pid && BigInt(item.startTicks) >= BigInt(leader.startTicks)))) { included.add(item.pid); changed = true; } }
  for (const item of processes) if (included.has(item.pid)) records.set(`${item.pid}:${item.startTicks}`, item);
  return [...records.values()].filter(item => { const current = birth(item.pid); return current && current.startTicks === item.startTicks; });
}
async function stage(name, args, timeoutMs, context) {
  const { root, output, environment } = context;
  const beganWall = Date.now();
  const beganMono = performance.now();
  const grantStopUtc = Date.parse(context.expiresAtUtc);
  demand(Number.isFinite(grantStopUtc), 'Absolute assigned stop required for every stage');
  const grantStopMono = beganMono + grantStopUtc - beganWall;
  const stageStopUtc = Math.min(beganWall + timeoutMs, grantStopUtc - 15_000);
  const stageStopMono = beganMono + stageStopUtc - beganWall;
  const cleanupStopUtc = Math.min(grantStopUtc, stageStopUtc + 15_000);
  const cleanupStopMono = Math.min(grantStopMono, stageStopMono + 15_000);
  const remaining = (utc, mono) => Math.max(0, Math.min(utc - Date.now(), mono - performance.now()));
  const stageExpired = () => remaining(stageStopUtc, stageStopMono) <= 0;
  const cleanupExpired = () => remaining(cleanupStopUtc, cleanupStopMono) <= 0;
  demand(!stageExpired(), 'Assigned stage stop reached before intent/spawn');
  async function boundedRace(promise, utc, mono, maximumMs) {
    const milliseconds = Math.min(maximumMs, remaining(utc, mono));
    if (milliseconds <= 0) return false;
    let completed = false;
    let timer;
    try {
      await Promise.race([Promise.resolve(promise).then(() => { completed = true; }), new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]);
    } finally { clearTimeout(timer); }
    // The caller checks its absolute boundary after this race, even if a timer
    // callback was delayed or the other promise had already settled.
    return completed;
  }
  const controller = birth(process.pid);
  demand(controller?.startTicks, 'Original controller birth required before stage intent');
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const beganAt = new Date(beganWall).toISOString();
  const intentBytes = Buffer.from(JSON.stringify({ schemaVersion: 3, state: 'STAGE_INTENT_BEFORE_SPAWN', name, command: { executable: process.execPath, args, cwd: root }, beganAt, timeoutMs, grantStopUtc, stageStopUtc, cleanupStopUtc, controller, bootId }, null, 2) + '\n');
  // Intent precedes spawn. A crash before child birth evidence must hold release.
  fs.writeFileSync(path.join(output, name + '.intent.json'), intentBytes, { flag: 'wx', mode: 0o600 });
  const stdout = fs.createWriteStream(path.join(output, name + '.stdout.log'), { flags: 'wx', mode: 0o600 });
  const stderr = fs.createWriteStream(path.join(output, name + '.stderr.log'), { flags: 'wx', mode: 0o600 });
  const logErrors = [];
  for (const stream of [stdout, stderr]) stream.on('error', error => logErrors.push({ code: error.code, message: error.message }));
  demand(!stageExpired(), 'Assigned stage stop reached immediately before spawn');
  const child = spawn(process.execPath, args, { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  const processes = new Map();
  const leader = child.pid ? birth(child.pid) : null;
  const birthBytes = Buffer.from(JSON.stringify({ schemaVersion: 3, state: leader ? 'ORIGINAL_CHILD_BIRTH_RECORDED' : 'MISSING_ORIGINAL_CHILD_BIRTH', name, intentSha256: sha(intentBytes), controller, bootId, leader }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, name + '.birth.json'), birthBytes, { flag: 'wx', mode: 0o600 });
  if (leader) processes.set(`${leader.pid}:${leader.startTicks}`, leader);
  let exit;
  let spawnError;
  let deadlineReached = false;
  let observedCloseUtc;
  let observedCloseMono;
  child.once('error', error => { spawnError = { name: error.name, code: error.code, message: error.message }; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => { observedCloseUtc = Date.now(); observedCloseMono = performance.now(); exit = { code, signal }; resolve(); }));
  const timer = setInterval(() => { if (leader) ownedProcesses(leader, processes); }, 250);
  if (leader) ownedProcesses(leader, processes);
  const watchdog = setTimeout(() => { deadlineReached = true; }, remaining(stageStopUtc, stageStopMono));
  // Keep the driver alive through close/owned-process absence; retain all raw
  // progress even when the separate diagnostic budget causes termination.
  while (!exit && !deadlineReached && !stageExpired()) {
    await boundedRace(closed, stageStopUtc, stageStopMono, 100);
    deadlineReached ||= stageExpired();
  }
  deadlineReached ||= stageExpired();
  const termination = [];
  if (deadlineReached || (leader && ownedProcesses(leader, processes).length)) {
    // A naturally closed leader can still leave children; allow a bounded grace.
    if (!deadlineReached) {
      await boundedRace(new Promise(() => {}), cleanupStopUtc, cleanupStopMono, 1000);
      deadlineReached ||= stageExpired();
    }
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const survivors = ownedProcesses(leader, processes);
      for (const item of survivors) {
        const current = birth(item.pid);
        if (!current || current.startTicks !== item.startTicks) continue;
        try { process.kill(item.pid, signal); termination.push({ pid: item.pid, startTicks: item.startTicks, signal }); }
        catch (error) { if (error.code !== 'ESRCH') termination.push({ pid: item.pid, signal, errorCode: error.code }); }
      }
      if (signal === 'SIGTERM' && survivors.length) {
        await boundedRace(new Promise(() => {}), cleanupStopUtc, cleanupStopMono, 5000);
        deadlineReached ||= stageExpired();
      }
    }
  }
  clearTimeout(watchdog);
  const closeObserved = await boundedRace(closed, cleanupStopUtc, cleanupStopMono, 5000);
  deadlineReached ||= stageExpired();
  clearInterval(timer);
  stdout.end(); stderr.end();
  const drained = Promise.all([new Promise(resolve => stdout.closed ? resolve() : stdout.once('close', resolve)), new Promise(resolve => stderr.closed ? resolve() : stderr.once('close', resolve))]);
  const logDrained = await boundedRace(drained, cleanupStopUtc, cleanupStopMono, 2000);
  deadlineReached ||= stageExpired();
  let cleanupDeadlineReached = cleanupExpired();
  if (!logDrained) { stdout.destroy(); stderr.destroy(); }
  const survivors = ownedProcesses(leader, processes);
  const unresolvedGroupMembers = child.pid ? fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(birth).filter(item => item && item.pgrp === child.pid && ![...processes.values()].some(record => record.pid === item.pid && record.startTicks === item.startTicks)) : [];
  deadlineReached ||= stageExpired();
  cleanupDeadlineReached ||= cleanupExpired();
  const result = { name, command: { executable: process.execPath, args, cwd: root }, beganAt, endedAt: new Date().toISOString(), timeoutMs, deadlineReached, spawnError, exit, natural: !!exit && !!leader && !exit.signal && !deadlineReached && termination.length === 0, leader, observedProcesses: [...processes.values()], termination, survivors, unresolvedGroupMembers };
  Object.assign(result, { schemaVersion: 3, intentSha256: sha(intentBytes), birthSha256: sha(birthBytes), controller, bootId });
  Object.assign(result, { grantStopUtc, stageStopUtc, cleanupStopUtc, observedCloseUtc, observedCloseMono, closeObserved, logDrained, logErrors, cleanupDeadlineReached });
  result.natural = result.natural && observedCloseUtc < stageStopUtc && observedCloseMono < stageStopMono && !stageExpired() && !cleanupDeadlineReached && closeObserved && logDrained && logErrors.length === 0;
  fs.writeFileSync(path.join(output, name + '.outcome.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  // A late synchronous evidence write cannot promote the result in the caller.
  // The immutable raw outcome remains partial evidence if this check refuses.
  demand(!cleanupExpired() && (!result.natural || !stageExpired()), 'Absolute stop crossed while preserving terminal evidence; caller must reject natural acceptance');
  demand(!!leader && closeObserved && logDrained && logErrors.length === 0 && !cleanupDeadlineReached && survivors.length === 0 && unresolvedGroupMembers.length === 0, 'Missing birth, late/incomplete close/drain or remaining/unknown group member; window cannot be released');
  return result;
}
async function main() {
  demand(process.platform === 'linux', 'Prepared profile is Linux only; no Windows fallback is authorized');
  const grantFile = arg('--grant');
  const count = Number(arg('--count'));
  demand(grantFile && [100, 250].includes(count), 'Required --grant absolute.json and --count 100|250');
  demand(path.isAbsolute(grantFile), 'Absolute external assignment path required');
  const grantBytes = fs.readFileSync(grantFile);
  const grant = JSON.parse(grantBytes);
  demand(grant.state === 'ASSIGNED' && grant.separateAppendWitnessAuthorized === true && grant.exclusiveWindowAssigned === true, 'New explicit separate diagnostic window assignment required');
  demand(grant.authorizedByRoot === true && grant.authorizedByQueue === true && grant.checkoutPurpose === 'append-phase-witness', 'Both coordinator and queue review plus separate owned checkout required');
  demand(grant.profile === 'linux-node22.23.3-uv1.51.0-default-heap' && grant.count === count, 'Grant profile/count mismatch');
  demand(Date.parse(grant.expiresAtUtc) > Date.now() && Date.parse(grant.notBeforeUtc) <= Date.now(), 'Grant time bounds invalid');
  demand(!process.env.NODE_OPTIONS && !process.env.CI_SKIP_PERF && process.execArgv.length === 0, 'Default heap and original performance policy required');
  demand(process.version === 'v22.23.3' && process.versions.uv === '1.51.0', 'Official matching Linux Node/libuv required');
  demand(process.arch === 'x64', 'Prepared official executable profile is x64 only');
  demand(/^ID=ubuntu$/m.test(fs.readFileSync('/etc/os-release', 'utf8')) && /^VERSION_ID="24\.04"$/m.test(fs.readFileSync('/etc/os-release', 'utf8')), 'Prepared OS profile is Ubuntu24.04 only');
  demand(sha(fs.readFileSync(process.execPath)) === 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48', 'Official Linux executable hash mismatch');
  demand(grant.npmCli && path.isAbsolute(grant.npmCli) && grant.npmCliSha256 === '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7' && sha(fs.readFileSync(grant.npmCli)) === grant.npmCliSha256, 'Explicit official npm10.9.9 CLI path/hash required');
  const npmVersion = JSON.parse(fs.readFileSync(path.resolve(path.dirname(grant.npmCli), '../package.json'))).version;
  demand(npmVersion === '10.9.9', 'Original Linux npm10.9.9 profile required; driver never invokes installation');
  const manifestBytes = fs.readFileSync(path.join(packet, 'manifest.json'));
  demand(sha(manifestBytes) === grant.packetManifestSha256, 'Reviewed packet manifest must match explicit assignment');
  const manifest = JSON.parse(manifestBytes);
  for (const member of manifest.members) demand(sha(fs.readFileSync(path.join(packet, member.file))) === member.sha256, 'Packet source changed: ' + member.file);
  const root = fs.realpathSync(grant.checkout);
  demand(path.isAbsolute(grant.checkout) && root === grant.checkout && root !== packet, 'Canonical dedicated checkout required');
  const git = args => command('git', ['-C', root, ...args]);
  demand(git(['rev-parse', '--show-toplevel']) === root, 'Git root mismatch');
  const head = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  demand(head === 'f67f215d2c698f961d28efdb50267454b4b1faf6' && tree === 'd09c5ccdd5a85d6e41061ecef683a0996d938c8e', 'This proposal pins the actual failed merge source; another source requires fresh review');
  demand(head === grant.head && tree === grant.tree && !['550c10c0194388d1b7014af85a3674936790e136', 'ff1a7c8acc56984622c42c160d52fc24a468546c'].includes(head), 'Exact assigned source; both frozen PR checkouts excluded');
  demand(git(['status', '--porcelain=v1', '--untracked-files=all']) === '', 'Clean owned checkout required');
  const sourceReport = JSON.parse(fs.readFileSync(path.join(packet, 'current-source-pins.json')));
  const pins = sourceReport.sourceComparison.pins.filter(pin => pin.role === 'traced append input');
  demand(pins.length === 19, 'Exact 19 traced source inputs required');
  const sourceBefore = pins.map(pin => {
    demand(git(['rev-parse', `HEAD:${pin.file}`]) === pin.gitBlob, 'Assigned source blob mismatch: ' + pin.file);
    demand(git(['hash-object', '--', pin.file]) === pin.gitBlob, 'Working source mismatch: ' + pin.file);
    return { file: pin.file, gitBlob: pin.gitBlob, sha256: sha(fs.readFileSync(path.join(root, pin.file))) };
  });
  if (count === 250) {
    demand(grant.previous100Receipt && grant.previous100Release, '100-count natural result and independent release required before250');
    const earlierBytes = fs.readFileSync(grant.previous100Receipt.file);
    const releasedBytes = fs.readFileSync(grant.previous100Release.file);
    demand(sha(earlierBytes) === grant.previous100Receipt.sha256 && sha(releasedBytes) === grant.previous100Release.sha256, 'Prior100 evidence hash mismatch');
    const earlier = JSON.parse(earlierBytes); const released = JSON.parse(releasedBytes);
    demand(earlier.count === 100 && earlier.head === head && earlier.tree === tree && earlier.packetManifestSha256 === grant.packetManifestSha256 && earlier.sourceRestored && earlier.state === 'SHORT_WITNESS_COMPLETED_NOT_PERFORMANCE_OR_ENDURANCE_QUALIFICATION' && earlier.stages.length === 2 && earlier.stages.every(item => item.natural && item.exit.code === 0), 'Prior100 sample must finish naturally on this exact source and diagnostic packet');
    demand(released.state === 'RELEASED' && released.knownProcessBirthsAbsent === true && released.controllerAlreadyExited === true && released.sourceClean === true && released.outputMembersMatch === true && released.releasedBy?.pid !== earlier.controller.pid && released.receiptSha256 === sha(earlierBytes), 'Prior100 independently released receipt required');
  }
  const dependencyGuard = require(path.join(root, 'scripts/local-test-dependencies.cjs'));
  const graph = dependencyGuard.assertLocalTestDependencies(root);
  demand(fs.realpathSync(graph.nodeModules) === path.join(root, 'node_modules'), 'Complete owned graph required; this driver never installs');
  const installedNext = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/next/package.json'))).version;
  demand(installedNext === '16.3.8', 'Expected owned locked Next16.3.8 required');
  for (const file of ['.env', '.env.local', '.env.test', '.env.test.local']) demand(!fs.existsSync(path.join(root, file)), 'Separate diagnostic checkout must not have unreviewed local env files');
  const outputParent = fs.realpathSync(grant.outputParent);
  demand(outputParent !== root && !outputParent.startsWith(root + path.sep) && outputParent !== packet && !outputParent.startsWith(packet + path.sep), 'New external receipt parent required');
  const output = path.join(outputParent, `append-phase-${count}-${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(output, { mode: 0o700 });
  const controller = birth(process.pid);
  demand(controller?.startTicks, 'Original witness controller birth required');
  const controllerIntentBytes = Buffer.from(JSON.stringify({ schemaVersion: 3, state: 'WITNESS_CONTROLLER_ENTERED_BEFORE_ANY_STAGE', controller, bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), count, head, tree, assignmentSha256: sha(grantBytes), packetManifestSha256: sha(manifestBytes), output }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'controller.intent.json'), controllerIntentBytes, { flag: 'wx', mode: 0o600 });
  const temporaryRoot = path.join(output, 'synthetic-temp');
  fs.mkdirSync(temporaryRoot, { mode: 0o700 });
  const installation = path.join(temporaryRoot, 'installation');
  fs.mkdirSync(installation, { mode: 0o700 });
  fs.writeFileSync(path.join(output, 'assignment.json'), grantBytes, { flag: 'wx', mode: 0o600 });
  const environment = { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH, FLUJO_APPEND_WITNESS_ROOT: root, FLUJO_APPEND_WITNESS_COUNT: String(count), FLUJO_APPEND_WITNESS_OBSERVER: path.join(packet, 'observer.cjs'), FLUJO_APPEND_WITNESS_PROGRESS: path.join(output, 'progress.jsonl'), FLUJO_APPEND_WITNESS_TRANSFORMS: path.join(output, 'transforms.jsonl'), FLUJO_APPEND_WITNESS_OUTPUT: output, FLUJO_APPEND_WITNESS_DATA_ROOT: installation, FLUJO_SKIP_PATCHRIGHT_DOWNLOAD: '1' };
  // Do not inherit test-selection, data, or observer switches from another run.
  for (const key of ['FLUJO_JEST_EXCLUDE_ISOLATED_SUITES', 'FLUJO_JEST_EXPECTED_TEST_FILES', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_DATA_DIR', 'NODE_OPTIONS', 'CI_SKIP_PERF']) delete environment[key];
  for (const key of Object.keys(environment)) if (key.startsWith('FLUJO_PERSONA_RUNTIME_EVENT_')) delete environment[key];
  const fixture = path.join(root, '__tests__', 'enduringAgents', `appendPhaseWitness-${crypto.randomUUID()}.test.ts`);
  const context = { root, output, environment, expiresAtUtc: grant.expiresAtUtc };
  const receipt = { schemaVersion: 1, state: 'DIAGNOSTIC_ENTERED_NOT_20K_QUALIFICATION', controller: { ...birth(process.pid), executable: process.execPath, executableSha256: sha(fs.readFileSync(process.execPath)) }, runtime: { node: process.version, uv: process.versions.uv, platform: process.platform, architecture: process.arch, defaultHeap: true, npmVersion, npmCli: grant.npmCli, npmCliSha256: grant.npmCliSha256, installedNext, osRelease: fs.readFileSync('/etc/os-release', 'utf8'), bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), lockfileSha256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))) }, count, head, tree, assignmentSha256: sha(grantBytes), packetManifestSha256: sha(manifestBytes), sourceBefore, output, fixture, stages: [], syntheticDataPreserved: true, independentPostControllerExitReleaseAuditRequired: true };
  let fixtureCreated = false;
  receipt.schemaVersion = 3;
  receipt.controllerIntentSha256 = sha(controllerIntentBytes);
  let failure;
  try {
    // Preparation never invokes this. The future assigned entry records the
    // normal dependency guard, then copies only this authored diagnostic fixture.
    demand(Date.now() + 220_000 < Date.parse(grant.expiresAtUtc), 'At least220s assigned time remaining required before first stage');
    receipt.stages.push(await stage('dependency-guard', [path.join(root, 'scripts/local-test-dependencies.cjs')], 20_000, context));
    demand(receipt.stages.at(-1).natural && receipt.stages.at(-1).exit.code === 0, 'Dependency guard must finish naturally with zero');
    fs.copyFileSync(path.join(packet, 'fixture.test.ts'), fixture, fs.constants.COPYFILE_EXCL);
    fixtureCreated = true;
    const args = [path.join(root, 'scripts/run-local-jest.cjs'), '--config', path.join(packet, 'jest-config.cjs'), '--selectProjects', 'node', '--runInBand', '--no-cache', '--testMatch', '**/__tests__/**/*.test.{ts,tsx}', '--runTestsByPath', fixture, '--json', '--outputFile', path.join(output, 'jest.json')];
    const outcome = await stage('witness', args, 180_000, context);
    receipt.stages.push(outcome);
    demand(outcome.natural && outcome.exit.code === 0, 'Short witness did not finish naturally with zero; partial evidence retained');
    const native = JSON.parse(fs.readFileSync(path.join(output, 'jest.json')));
    demand(native.numPassedTests === 1 && native.numFailedTests === 0 && native.numPendingTests === 0 && native.numTotalTestSuites === 1 && native.testResults.length === 1 && native.testResults[0].name === fixture, 'Exact one-suite/one-test native execution required');
    const progress = fs.readFileSync(path.join(output, 'progress.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    demand(progress.some(item => item.phase === 'complete' && item.completed === count && item.lastSeq === count - 1), 'Exact completed append/tail witness missing');
    demand(progress.every(item => !item.observationOverflow && item.observerErrors.length === 0 && Object.entries(item.workLimits).every(([key, maximum]) => item.work[key] <= maximum)), 'Observer error/overflow or work-budget overrun invalidates this diagnostic');
    const transformed = fs.readFileSync(path.join(output, 'transforms.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    demand(new Set(transformed.map(item => item.file)).size === 6 && transformed.every(item => sourceBefore.some(pin => pin.file === item.file && pin.sha256 === item.originalSha256)) && transformed.reduce((sum, item) => sum + item.functions.length, 0) === 20, 'Six exact joined source transforms and20 named functions required');
    receipt.state = 'SHORT_WITNESS_COMPLETED_NOT_PERFORMANCE_OR_ENDURANCE_QUALIFICATION';
  } catch (error) {
    failure = error;
    receipt.state = 'SHORT_WITNESS_FAILED_OR_BOUNDED_TERMINATION_PARTIAL_EVIDENCE_RETAINED';
    receipt.error = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    if (fixtureCreated) {
      try {
        demand(sha(fs.readFileSync(fixture)) === sha(fs.readFileSync(path.join(packet, 'fixture.test.ts'))), 'Temporary authored fixture changed; preserve it for review');
        fs.unlinkSync(fixture); // Only the exact exclusive-created file is removed.
      } catch (error) { receipt.cleanupError = { name: error.name, message: error.message }; failure ??= error; }
    }
    receipt.sourceAfter = sourceBefore.map(pin => ({ file: pin.file, sha256: sha(fs.readFileSync(path.join(root, pin.file))), unchanged: sha(fs.readFileSync(path.join(root, pin.file))) === pin.sha256 }));
    receipt.afterHead = git(['rev-parse', 'HEAD']); receipt.afterTree = git(['rev-parse', 'HEAD^{tree}']); receipt.afterStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
    receipt.sourceRestored = receipt.sourceAfter.every(pin => pin.unchanged) && receipt.afterHead === head && receipt.afterTree === tree && receipt.afterStatus === '';
    receipt.endedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const members = fs.readdirSync(output).filter(file => fs.statSync(path.join(output, file)).isFile()).map(file => ({ file, bytes: fs.statSync(path.join(output, file)).size, sha256: sha(fs.readFileSync(path.join(output, file))) }));
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, members, excludesPreservedSyntheticSubtree: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    demand(receipt.sourceRestored, 'Source/clean checkout postcondition failed');
  }
  if (failure) throw failure;
  process.stdout.write(JSON.stringify({ state: receipt.state, output, independentPostControllerExitReleaseAuditRequired: true }) + '\n');
}
module.exports = { birth, stage, sha, demand };
if (require.main === module) main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
