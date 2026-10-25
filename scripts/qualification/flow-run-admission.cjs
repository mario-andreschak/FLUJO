#!/usr/bin/env node
'use strict';

/**
 * Finite Source profile of actual Flow admission and conversation locks only.
 * Run: node scripts/qualification/flow-run-admission.cjs --output ABSOLUTE_NEW_DIRECTORY
 * The caller owns cleanup of the preserved, exclusively created output root.
 * No provider, runFlow engine, production state, forced GC or heap override.
 * Passing this equipment does not establish 24-hour, full-runtime, original
 * #520 provider, installed-artifact or elapsed Persona acceptance.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { getHeapStatistics } = require('node:v8');
const { PerformanceObserver } = require('node:perf_hooks');

const ROOT = fs.realpathSync(path.resolve(__dirname, '../..'));
const MiB = 1024 * 1024;
// Fixed before measurement. Do not raise caps/deadlines after a failed run.
const PROFILE = Object.freeze({
  schemaVersion: 1, rounds: 64, warmupRounds: 8, baselineWindowRounds: 8, finalWindowRounds: 8,
  lanesPerRound: 8, expectedAdmittedWaiters: 4, parentCharacters: 2_000_000,
  childCharacters: [3_600_000, 4_000_000, 4_400_000, 4_800_000, 5_200_000, 5_600_000, 3_800_000, 4_200_000],
  inlineMediaBytes: 64 * 1024, sampleIntervalMs: 50, externalSampleIntervalMs: 250,
  childDeadlineMs: 180_000, maxLogBytes: 8 * MiB, maxSamples: 12_000,
  ceilings: { rss: 1024 * MiB, heapUsed: 768 * MiB, external: 128 * MiB, arrayBuffers: 96 * MiB },
  growthTolerance: { rss: 256 * MiB, heapUsed: 192 * MiB, external: 64 * MiB, arrayBuffers: 64 * MiB },
  inspectorSamplingIntervalBytes: 32768, maxAllocationProfileBytes: 32 * MiB,
  seed: 'flujo-569-finite-admission-lock-v1',
});
const SOURCE_FILES = [
  'scripts/qualification/flow-run-admission.cjs',
  'src/backend/execution/flow/runAdmission.ts',
  'src/backend/execution/flow/conversationExecutionLock.ts',
  'src/utils/workspace.ts', 'src/utils/paths.ts', 'package-lock.json',
];
const LIMITATIONS = [
  'Finite synthetic admission/lock Source profile; no runFlow engine, HTTP/SSE, provider, archive or production-state execution.',
  'Four is the configured per-conversation admission limit; the lock itself executes one waiter at a time.',
  'The comparison bypasses admission functions only in this harness; it must fail the expected-four-waiters invariant without an arbitrary failure or OOM.',
  'Timer samples miss synchronous allocation peaks; OS observations and resourceUsage maximum RSS are reported separately when available.',
  'Window growth compares final-eight drained samples with eight drained samples after warmup without forced GC; it cannot prove leak freedom or 24-hour stability.',
  'Synthetic materialized hexadecimal histories and bounded inline bytes are not the original transcript, tokenizer counts, media hydration or provider workload.',
  'Both modes intentionally construct input before admission. Rejected payloads are not stored by the harness; diagnostic counters and hashes contain no raw payload.',
  'The caller owns cleanup. All evidence, including failures, is retained outside the checkout.',
];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const delayTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const inside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const writeJson = (file, value) => fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function sourceManifest() {
  const sourceHashes = {};
  for (const file of SOURCE_FILES) {
    const real = await fsp.realpath(path.join(ROOT, file));
    assert(inside(ROOT, real), 'Source escapes checkout: ' + file);
    sourceHashes[file] = await fileDigest(real);
  }
  const modules = await fsp.realpath(path.join(ROOT, 'node_modules'));
  const typescriptEntry = await fsp.realpath(require.resolve('typescript', { paths: [ROOT] }));
  assert(inside(modules, typescriptEntry), 'TypeScript must resolve inside this checkout installation');
  const typescriptPackage = path.join(path.dirname(path.dirname(typescriptEntry)), 'package.json');
  const metadata = JSON.parse(await fsp.readFile(typescriptPackage, 'utf8'));
  assert.equal(metadata.name, 'typescript');
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(),
    sourceHashes, profileSha256: digest(JSON.stringify(PROFILE)),
    typescript: { version: metadata.version, entrySha256: await fileDigest(typescriptEntry),
      packageSha256: await fileDigest(typescriptPackage) },
  };
}

function sourceLoader() {
  const ts = require(require.resolve('typescript', { paths: [ROOT] }));
  const resolve = Module._resolveFilename;
  const permitted = new Set(SOURCE_FILES.filter(file => file.endsWith('.ts')).map(file => fs.realpathSync(path.join(ROOT, file))));
  const loaded = new Set();
  Module._resolveFilename = function(request, parent, ...rest) {
    if (request.startsWith('@/')) request = path.join(ROOT, 'src', request.slice(2));
    return resolve.call(this, request, parent, ...rest);
  };
  require.extensions['.ts'] = (module, file) => {
    const real = fs.realpathSync(file);
    assert(permitted.has(real), 'Unexpected TypeScript dependency: ' + file);
    loaded.add(path.relative(ROOT, real).split(path.sep).join('/'));
    module._compile(ts.transpileModule(fs.readFileSync(real, 'utf8'), { fileName: real,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, real);
  };
  return loaded;
}

async function cgroup() {
  const result = {};
  for (const name of ['memory.max', 'memory.current', 'memory.peak', 'memory.events']) {
    try { result[name] = await fsp.readFile('/sys/fs/cgroup/' + name, 'utf8'); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      result[name] = null;
    }
  }
  return result;
}

function materializedText(round, lane, characters) {
  // SHAKE emits distinct deterministic bytes across every round/lane. Hex output
  // is a complete materialized ASCII string, not a repeated block or rope.
  assert.equal(characters % 2, 0);
  return crypto.createHash('shake256', { outputLength: characters / 2 })
    .update(PROFILE.seed + '/' + round + '/' + lane).digest('hex');
}

async function inspectorStart() {
  const inspector = require('node:inspector');
  const session = new inspector.Session();
  session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  try {
    await post('HeapProfiler.startSampling', {
      samplingInterval: PROFILE.inspectorSamplingIntervalBytes,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
    });
    return { post, session };
  } catch (error) {
    session.disconnect();
    return { unavailable: String(error) };
  }
}

function maxima(samples) {
  return Object.fromEntries(Object.keys(PROFILE.ceilings).map(key => [key, Math.max(...samples.map(sample => sample.memory[key]))]));
}

async function worker(mode, output) {
  assert(['guarded', 'admission-off'].includes(mode), 'Unknown comparison mode');
  const base = await fsp.realpath(output);
  assert(!inside(ROOT, base), 'Evidence must remain outside checkout');
  const manifest = JSON.parse(await fsp.readFile(path.join(base, 'source-manifest.json'), 'utf8'));
  assert.deepEqual(await sourceManifest(), manifest, 'Source changed before worker entry');
  const directory = path.join(base, mode);
  assert.equal(await fsp.realpath(directory), directory);
  process.env.FLUJO_DATA_DIR = path.join(directory, 'data');
  await fsp.mkdir(process.env.FLUJO_DATA_DIR);
  const loadedSource = sourceLoader();
  const admission = require(path.join(ROOT, 'src/backend/execution/flow/runAdmission.ts'));
  const locks = require(path.join(ROOT, 'src/backend/execution/flow/conversationExecutionLock.ts'));
  const workspace = require(path.join(ROOT, 'src/utils/workspace.ts'));
  assert.deepEqual([...loadedSource].sort(), SOURCE_FILES.filter(file => file.endsWith('.ts')).sort(),
    'The profile must load exactly the pinned admission/lock/workspace/path sources');
  assert.equal(workspace.getCurrentWorkspace(), workspace.DEFAULT_WORKSPACE);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert(!process.execArgv.some(value => /heap|expose-gc/.test(value)), 'Heap/GC override forbidden');
  // The configuration is explicit and identical between controls. The control's
  // sole difference is local omission of acquire/scope/claim/recheck calls below.
  Object.assign(process.env, {
    FLUJO_RUN_ADMISSION_MAX_PROCESS_RUNS: '64', FLUJO_RUN_ADMISSION_MAX_WORKSPACE_RUNS: '32',
    FLUJO_RUN_ADMISSION_MAX_CONVERSATION_RUNS: String(PROFILE.expectedAdmittedWaiters),
    FLUJO_RUN_ADMISSION_MAX_PROCESS_BYTES: String(512 * MiB),
    FLUJO_RUN_ADMISSION_MAX_WORKSPACE_BYTES: String(256 * MiB),
    FLUJO_RUN_ADMISSION_MAX_INPUT_BYTES: String(64 * MiB),
    FLUJO_RUN_ADMISSION_MAX_RSS_BYTES: String(2048 * MiB),
  });
  const initialCgroup = await cgroup();
  const started = performance.now();
  let phase = 'baseline', round = -1, gcCount = 0, gcDurationMs = 0, pendingWaiters = 0;
  const samples = [], rounds = [];
  const allPayloads = crypto.createHash('sha256');
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) { gcCount++; gcDurationMs += entry.duration; }
  });
  observer.observe({ entryTypes: ['gc'] });
  const sample = () => {
    assert(samples.length < PROFILE.maxSamples, 'Sample capacity exceeded');
    const value = { elapsedMs: performance.now() - started, phase, round,
      memory: process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024,
      gcCount, gcDurationMs, pendingWaiters, pressure: admission.getFlowRunAdmissionDiagnostics() };
    samples.push(value);
    if (process.connected) process.send({ kind: 'sample', value });
    return value;
  };
  const allocation = await inspectorStart();
  sample();
  const timer = setInterval(sample, PROFILE.sampleIntervalMs);
  let completed = false;
  try {
    for (round = 0; round < PROFILE.rounds; round++) {
      phase = 'construct-parent';
      const parentText = materializedText(round, 'parent', PROFILE.parentCharacters);
      const parentHash = digest(parentText);
      allPayloads.update(JSON.stringify([round, 'parent', parentHash]));
      const conversationId = 'finite-admission-conversation';
      const entered = deferred(), unlock = deferred();
      const heldLock = locks.withConversationExecutionLock(conversationId, async () => {
        entered.resolve(); await unlock.promise;
      });
      await entered.promise;
      const promises = [], executed = [], payloadHashes = [];
      let admitted = 0, refused = 0, maximumPending = 0;
      // Function-local inputs disappear immediately upon refusal. Only admitted
      // lock promises retain payloads; receipts contain hashes/counts/order only.
      const submit = lane => {
        const text = materializedText(round, lane, PROFILE.childCharacters[lane]);
        const media = crypto.createHash('shake256', { outputLength: PROFILE.inlineMediaBytes })
          .update(PROFILE.seed + '/media/' + round + '/' + lane).digest('base64');
        const textHash = digest(text), mediaHash = digest(media);
        payloadHashes.push({ lane, textHash, mediaHash });
        allPayloads.update(JSON.stringify([round, lane, textHash, mediaHash]));
        const input = { conversationId, messages: [
          { role: 'user', content: parentText }, { role: 'user', content: text },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:application/octet-stream;base64,' + media } }] },
        ] };
        let permit;
        try {
          permit = mode === 'guarded' ? admission.acquireFlowRunAdmission(input) : { release() {} };
        } catch (error) {
          assert(mode === 'guarded' && admission.isFlowRunPressureError(error), 'Unexpected admission failure');
          assert.equal(error.code, 'FLOW_RUN_BUSY', 'The reference workload must reach count pressure, not memory/input refusal');
          refused++;
          return;
        }
        admitted++; pendingWaiters++;
        maximumPending = Math.max(maximumPending, pendingWaiters);
        const execute = async () => {
          if (mode === 'guarded') assert.equal(admission.claimFlowRunAdmission(input), permit);
          await locks.withConversationExecutionLock(conversationId, async () => {
            if (mode === 'guarded') admission.recheckFlowRunAdmission(permit, input);
            assert.equal(digest(input.messages[0].content), parentHash, 'Parent changed while queued');
            assert.equal(digest(input.messages[1].content), textHash, 'Child changed while queued');
            assert.equal(digest(input.messages[2].content[0].image_url.url.slice('data:application/octet-stream;base64,'.length)), mediaHash);
            executed.push(lane);
          });
        };
        const promise = (mode === 'guarded' ? admission.withFlowRunAdmission(permit, execute) : execute())
          .finally(() => { pendingWaiters--; permit.release(); });
        promises.push(promise);
      };
      let queuedSample;
      try {
        phase = 'construct-and-queue';
        for (let lane = 0; lane < PROFILE.lanesPerRound; lane++) submit(lane);
        assert(locks.isConversationExecutionLocked(conversationId));
        assert.deepEqual(executed, [], 'Waiters must not bypass the held real lock');
        phase = 'queued'; queuedSample = sample();
        const expected = mode === 'guarded' ? PROFILE.expectedAdmittedWaiters : PROFILE.lanesPerRound;
        assert.equal(admitted, expected);
        assert.equal(refused, PROFILE.lanesPerRound - expected);
        assert.equal(maximumPending, expected);
        assert.equal(queuedSample.pressure.activeRuns, mode === 'guarded' ? expected : 0);
      } finally { unlock.resolve(); await heldLock; }
      phase = 'drain';
      await Promise.all(promises);
      assert.deepEqual(executed, Array.from({ length: admitted }, (_, lane) => lane), 'Lock FIFO changed');
      assert.equal(digest(parentText), parentHash);
      assert.equal(pendingWaiters, 0);
      assert(!locks.isConversationExecutionLocked(conversationId), 'Real conversation lock did not drain');
      assert.equal(globalThis.__flujoConversationExecutionLocks.size, 0);
      assert.equal(admission.getFlowRunAdmissionDiagnostics().activeRuns, 0);
      assert.equal(admission.getFlowRunAdmissionDiagnostics().reservedBytes, 0);
      rounds.push({ round, admitted, refused, maximumPending, executed, payloadHashes, parentHash,
        expectedCountInvariantPassed: admitted <= PROFILE.expectedAdmittedWaiters });
      phase = 'drained'; sample();
      await delayTurn();
    }
    phase = 'settled'; sample();
    let allocationProfile = { available: false, reason: allocation.unavailable };
    if (allocation.session) {
      const result = await allocation.post('HeapProfiler.stopSampling');
      const bytes = JSON.stringify(result.profile);
      assert(Buffer.byteLength(bytes) <= PROFILE.maxAllocationProfileBytes, 'Allocation profile exceeded evidence cap');
      await fsp.writeFile(path.join(directory, 'allocation.heapprofile'), bytes, { flag: 'wx' });
      allocationProfile = { available: true, samplingIntervalBytes: PROFILE.inspectorSamplingIntervalBytes,
        sha256: digest(bytes), bytes: Buffer.byteLength(bytes), includesCollectedObjects: true };
    }
    const drainedSamples = samples.filter(value => value.phase === 'drained');
    const baseline = maxima(drainedSamples.filter(value => value.round >= PROFILE.warmupRounds
      && value.round < PROFILE.warmupRounds + PROFILE.baselineWindowRounds));
    const finalWindow = maxima(drainedSamples.filter(value => value.round >= PROFILE.rounds - PROFILE.finalWindowRounds));
    const observedMaxima = maxima(samples);
    const growth = Object.fromEntries(Object.keys(PROFILE.growthTolerance).map(key => [key, Math.max(0, finalWindow[key] - baseline[key])]));
    for (const [key, ceiling] of Object.entries(PROFILE.ceilings)) assert(observedMaxima[key] <= ceiling, key + ' ceiling exceeded');
    if (mode === 'guarded') {
      for (const [key, tolerance] of Object.entries(PROFILE.growthTolerance)) assert(growth[key] <= tolerance, key + ' finite-window growth exceeded');
    }
    const failingInvariantRounds = rounds.filter(value => !value.expectedCountInvariantPassed).length;
    assert.equal(failingInvariantRounds, mode === 'guarded' ? 0 : PROFILE.rounds);
    assert.deepEqual(await sourceManifest(), manifest, 'Source changed during measurement');
    await writeJson(path.join(directory, 'result.json'), {
      mode, completed: true, source: manifest, profile: PROFILE, limitations: LIMITATIONS,
      node: process.version, execPathSha256: await fileDigest(process.execPath), execArgv: process.execArgv,
      nodeOptions: process.env.NODE_OPTIONS ?? null, platform: process.platform, arch: process.arch,
      osRelease: os.release(), osTotalMemory: os.totalmem(), heapSizeLimit: getHeapStatistics().heap_size_limit,
      loadedSource: [...loadedSource].sort(), controlScope: mode === 'admission-off' ? 'Harness-only bypass of acquire/scope/claim/recheck' : 'Actual admission calls',
      elapsedMs: performance.now() - started, gcCount, gcDurationMs, allocationProfile,
      observedMaxima, baseline, finalWindow, growth, failingInvariantRounds,
      workloadSha256: allPayloads.digest('hex'), rounds, samples,
      pressure: admission.getFlowRunAdmissionDiagnostics(), pendingWaiters,
      lockEntries: globalThis.__flujoConversationExecutionLocks.size,
      cgroupBefore: initialCgroup, cgroupAfter: await cgroup(),
    });
    completed = true;
  } finally {
    clearInterval(timer); observer.disconnect(); allocation.session?.disconnect();
    await writeJson(path.join(directory, 'settlement.json'), { completed, phase, round, pendingWaiters,
      pressure: admission.getFlowRunAdmissionDiagnostics(), lockEntries: globalThis.__flujoConversationExecutionLocks?.size ?? null });
  }
}

async function externalMemory(pid) {
  if (process.platform === 'linux') {
    const status = await fsp.readFile('/proc/' + pid + '/status', 'utf8');
    const field = name => Number(status.match(new RegExp('^' + name + ':\\s+(\\d+) kB$', 'm'))?.[1]) * 1024;
    return { rss: field('VmRSS'), peakRss: field('VmHWM'), mechanism: '/proc/PID/status' };
  }
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    return new Promise((resolve, reject) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; @{rss=$p.WorkingSet64;peakRss=$p.PeakWorkingSet64} | ConvertTo-Json -Compress`],
    { windowsHide: true, timeout: 2000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) reject(error);
      else { try { resolve({ ...JSON.parse(stdout), mechanism: 'Get-Process working set' }); } catch (problem) { reject(problem); } }
    }));
  }
  throw new Error('External RSS observer unavailable on ' + process.platform + '; worker memoryUsage samples remain recorded');
}

async function supervise(mode, output, manifest) {
  const directory = path.join(output, mode);
  await fsp.mkdir(directory);
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.NODE_ENV = 'test';
  const child = spawn(process.execPath, [__filename, '--worker', mode, output], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const logs = { stdout: [], stderr: [] }, samples = [], externalSamples = [];
  let outputBytes = 0, stopped, spawnError, exitEvent, stdoutEnded = false, stderrEnded = false, closeObserved = false;
  const streamErrors = [];
  const stop = reason => { if (!stopped) { stopped = reason; child.kill('SIGKILL'); } };
  for (const name of ['stdout', 'stderr']) {
    child[name].on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > PROFILE.maxLogBytes) stop('log-byte-ceiling');
      else logs[name].push(Buffer.from(chunk));
    });
    child[name].once('end', () => { if (name === 'stdout') stdoutEnded = true; else stderrEnded = true; });
    child[name].once('error', error => { streamErrors.push(name + ': ' + String(error)); stop('stream-error'); });
  }
  child.once('error', error => { spawnError = String(error); });
  child.once('exit', (code, signal) => { exitEvent = { code, signal }; });
  child.on('message', message => {
    if (message?.kind !== 'sample') { stop('unexpected-worker-message'); return; }
    if (samples.length >= PROFILE.maxSamples) { stop('sample-capacity'); return; }
    samples.push(message.value);
    for (const [key, ceiling] of Object.entries(PROFILE.ceilings)) {
      if (!Number.isFinite(message.value.memory?.[key]) || message.value.memory[key] > ceiling) stop(key + '-sample-ceiling');
    }
    if (message.value.maxRssBytes > PROFILE.ceilings.rss) stop('resourceUsage-rss-ceiling');
  });
  const started = performance.now();
  let externalPending = Promise.resolve(), observing = false, externalUnavailable;
  const observe = () => {
    if (observing || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    observing = true;
    externalPending = externalMemory(child.pid).then(value => {
      externalSamples.push({ elapsedMs: performance.now() - started, ...value });
      if (value.rss > PROFILE.ceilings.rss || value.peakRss > PROFILE.ceilings.rss) stop('external-rss-ceiling');
    }, error => { externalUnavailable = String(error); }).finally(() => { observing = false; });
  };
  const poll = setInterval(observe, PROFILE.externalSampleIntervalMs);
  observe();
  const deadline = setTimeout(() => stop('child-deadline'), PROFILE.childDeadlineMs);
  const close = await new Promise(resolve => child.once('close', (code, signal) => {
    closeObserved = true; resolve({ code, signal });
  }));
  clearTimeout(deadline); clearInterval(poll); await externalPending;
  await fsp.writeFile(path.join(directory, 'stdout.log'), Buffer.concat(logs.stdout), { flag: 'wx' });
  await fsp.writeFile(path.join(directory, 'stderr.log'), Buffer.concat(logs.stderr), { flag: 'wx' });
  await writeJson(path.join(directory, 'supervisor.json'), {
    mode, pid: child.pid, exitEvent, close, stdoutEnded, stderrEnded, closeObserved, streamErrors,
    spawnError: spawnError ?? null, stopped: stopped ?? null, outputBytes,
    elapsedMs: performance.now() - started, parentNode: process.version,
    source: manifest, samples, externalSamples, externalUnavailable: externalUnavailable ?? null,
    processAndStdioClosed: !!exitEvent && stdoutEnded && stderrEnded && closeObserved && streamErrors.length === 0,
  });
  assert(!spawnError && !stopped && exitEvent?.code === 0 && exitEvent.signal === null
    && close.code === 0 && close.signal === null && stdoutEnded && stderrEnded && closeObserved && !streamErrors.length,
  'Worker failure; preserved evidence: ' + directory);
  const result = JSON.parse(await fsp.readFile(path.join(directory, 'result.json'), 'utf8'));
  assert(result.completed && result.samples.length > PROFILE.rounds * 2 && samples.length > PROFILE.rounds * 2);
  assert.equal(result.nodeOptions, null);
  assert.deepEqual(result.execArgv, []);
  assert.equal(result.rounds.length, PROFILE.rounds);
  assert.equal(result.pendingWaiters, 0);
  assert.equal(result.pressure.activeRuns, 0);
  assert.equal(result.pressure.reservedBytes, 0);
  assert.equal(result.lockEntries, 0);
  assert.deepEqual(await sourceManifest(), manifest, 'Source changed between controls');
  return result;
}

async function main() {
  if (process.argv[2] === '--worker') return worker(process.argv[3], process.argv[4]);
  assert.equal(process.argv.length, 4, 'Usage: node scripts/qualification/flow-run-admission.cjs --output ABSOLUTE_NEW_DIRECTORY');
  assert.equal(process.argv[2], '--output');
  const requested = process.argv[3];
  assert(path.isAbsolute(requested), 'Output must be an explicit absolute new directory');
  const output = path.resolve(requested);
  assert(!inside(ROOT, output), 'Output must be outside checkout');
  const parent = await fsp.realpath(path.dirname(output));
  assert.equal(path.join(parent, path.basename(output)), output, 'Output parent must have canonical identity');
  await fsp.mkdir(output); // Exclusive: never reuse or overwrite prior evidence.
  const manifest = await sourceManifest();
  await writeJson(path.join(output, 'source-manifest.json'), manifest);
  await writeJson(path.join(output, 'owner.json'), { createdAt: new Date().toISOString(), parentPid: process.pid,
    output, source: manifest, profile: PROFILE, limitations: LIMITATIONS, cleanupOwner: 'caller' });
  try {
    const guarded = await supervise('guarded', output, manifest);
    const control = await supervise('admission-off', output, manifest);
    for (const key of ['node', 'execPathSha256', 'platform', 'arch', 'heapSizeLimit', 'workloadSha256']) {
      assert.deepEqual(guarded[key], control[key], 'Comparison identity mismatch: ' + key);
    }
    assert.equal(guarded.failingInvariantRounds, 0);
    assert.equal(control.failingInvariantRounds, PROFILE.rounds, 'Negative control did not fail the expected count invariant');
    await writeJson(path.join(output, 'comparison.json'), { completed: true, source: manifest, profile: PROFILE,
      guarded: { observedMaxima: guarded.observedMaxima, growth: guarded.growth, countInvariantFailures: 0 },
      admissionOff: { observedMaxima: control.observedMaxima, growth: control.growth, countInvariantFailures: control.failingInvariantRounds },
      workloadSha256: guarded.workloadSha256, limitations: LIMITATIONS });
    process.stdout.write(JSON.stringify({ completed: true, output, guardedCountInvariantFailures: 0,
      controlCountInvariantFailures: control.failingInvariantRounds }) + '\n');
  } catch (error) {
    await writeJson(path.join(output, 'failure.json'), { completed: false, error: String(error), stack: error.stack,
      source: manifest, limitations: LIMITATIONS });
    throw error;
  }
}

if (require.main === module) main().catch(error => {
  process.stderr.write((error.stack || String(error)) + '\n');
  process.exitCode = 1;
});
