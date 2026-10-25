'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROFILE, profileSha256, harnessDigest, MiB, GiB, validatePlan: validatePlanBound, estimateStorage, inside,
  canonicalTextHash, sourceManifestHash, validateLaunchIdentity, readPilotEvidence, hash } = require('./profile.cjs');
const { makePlan: makePlanBound } = require('./plan.cjs');
const { BoundedJsonl, DrainWindows, directoryBytes } = require('./evidence.cjs');
const { allocationWindowLabel, BatchAllocationSampler } = require('./inspector-evidence.cjs');
const { history } = require('./fixtures.cjs');
const { createProvider } = require('./provider.cjs');
const { verifySourceManifest } = require('./source-loader.cjs');
const bridgeMetadata = { name: '@modelcontextprotocol/ext-tasks', version: '0.2.2', type: 'module',
  exports: Object.fromEntries(['core', 'core/v2', 'client'].map(key => ['./' + key, { import: './' + key.replace('/', '-') + '.js' }])) };
const bridgeSource = 'export const value = 1;\n';
const bridgeFixture = () => ({ format: 'declared-import-exports-v1', package: bridgeMetadata.name, version: bridgeMetadata.version,
  packageJsonSha256: canonicalTextHash(JSON.stringify(bridgeMetadata)), exportsSha256: canonicalTextHash(JSON.stringify(bridgeMetadata.exports)),
  entries: Object.fromEntries(Object.entries(bridgeMetadata.exports).map(([key, value]) => [bridgeMetadata.name + key.slice(1),
    { target: value.import, sha256: canonicalTextHash(bridgeSource) }])) });
const { assertSettledDiagnostics, assertChildOutcome, foldIdentity, TERMINAL_MARKER, TERMINAL_CODE, RETRY_MARKER } = require('./checks.cjs');
const source = () => ({ format: 'source-lf-v1', files: { 'src/runtime.ts': canonicalTextHash('runtime\n') },
  typescript: 'fixture-version', openaiEntrySha256: canonicalTextHash('sdk\n'), lockSha256: canonicalTextHash('lock\n'), importBridge: bridgeFixture() });
const datasetFilesystem = () => ({ path:'/opt/flujo569/qualification/fixture/output', realPath:'/opt/flujo569/qualification/fixture/output',
  filesystemMagic:'0xef53', filesystem:'ext4', device:2048, inode:1234 });
const receiptNames = ['runtime-receipt.json','supervisor-receipt.json','runtime-settled.json','provider-settled.json'];
const mirrorFixture = () => ({ complete:true, version:'ext4-receipt-mirror-v1', phase:'fixture', token:'fixture-token',
  datasetFilesystem:datasetFilesystem(), files:Object.fromEntries(receiptNames.map(name => [name,{bytes:1,sha256:'a'.repeat(64),
    sourcePath:datasetFilesystem().path+'/'+name}])) });
const pilot = () => ({ mode: 'pilot', platform: 'win32', node: 'v22.23.4', completed: true, sourceHead: 'revision', profileSha256, harnessSha256: harnessDigest(),
  source: source(), datasetFilesystem: datasetFilesystem(),
  disk: { bytes: 240 * MiB }, batches: [{ diskBytesAdded: 100 * MiB, elapsedMs: 100_000 }, { diskBytesAdded: 120 * MiB, elapsedMs: 130_000 }] });
const supervisor = () => ({ completed: true, sourceHead: 'revision', profileSha256, harnessSha256: harnessDigest(),
  datasetFilesystem: datasetFilesystem(), guestDiskAdmissions:[1,2].map(() => ({ filesystem:datasetFilesystem(), freeBytes:100*GiB, requiredFreeBytes:22*GiB })),
  processes: { windowsJob: { activeProcessesBeforeCleanup: 0, forcedCleanup: false } },
  envelope: { path: '/aggregate', workloadPath: '/aggregate/workload', guardianIncluded: true },
  diskAdmissions: [1, 2].map(sequence => ({ kind: 'windows-physical-volume-v1', volume: 'C:\\', admitted: true,
    freeBytes: 100 * GiB, currentLauncherSha256: 'a'.repeat(64), request: { sequence, requiredFreeBytes: 22 * GiB, mode: 'pilot', planSha256: null,
      sourceHead: 'revision', profileSha256, harnessSha256: harnessDigest(), node: 'v22.23.4', launcherSha256: 'a'.repeat(64) } })) });
function ownership(p, s) { return { completed: true, equipmentOnly: false, launcherSha256: 'a'.repeat(64), platform: p?.platform, supervisor: s,
  mcp: { serverExited: true, serverExitCode: 0, serverExitSignal: null, stderrEnded: true, transportClosed: true, resultError: false },
  guard: { datasetMirror:mirrorFixture(), completed: true, jobActiveProcesses: 0, forcedCleanup: false, childExitCode: 0, stdoutEnded: true, stderrEnded: true, copyThreadsStopped: true,
    errors: [], stoppedByGuard: null, hostBackingVolume: 'C:\\', diskFloorBytes: 20 * GiB,
    minimumHostDiskFreeBytes: 50 * GiB, diskAdmissions: s?.diskAdmissions },
  linux: { token:'fixture-token', datasetMirror:mirrorFixture(), reason: 'command completed', forcedCleanup: false, beforeCleanupMembers: [], cleanupErrors: [], childExitCode: 0, remainingWorkloadMembers: [],
    workloadCgroupEvents: 'populated 0\nfrozen 0', aggregateCgroup: '/aggregate', workloadCgroup: '/aggregate/workload' } }; }
const makePlanRaw = (p, s, c, peer, ps) => makePlanBound(p, s, c, peer, ps, ownership(p, s), ownership(peer, ps));
const validatePlanRaw = (plan, p, head, s, peer, ps) => validatePlanBound(plan, p, head, s, peer, ps, ownership(p, s), ownership(peer, ps));
const makePlan = (p, s, cadence) => makePlanRaw(p, s, cadence, { ...p, platform: 'linux' }, s);
const validatePlan = (plan, p, head, s) => validatePlanRaw(plan, p, head, s, { ...p, platform: 'linux' }, s);

test('fixed envelope and full elapsed duration are independent of number of batches', () => {
  assert.equal(PROFILE.enduranceMs, 86_400_000); assert.equal(PROFILE.baselineStartMs, 7_200_000);
  assert.equal(PROFILE.budgets.aggregateBytes, 2 * GiB); assert.equal(PROFILE.budgets.appRss, GiB);
  assert.equal(PROFILE.budgets.cpus, 2); assert.equal(PROFILE.maxActiveChildren, 4);
  assert.equal(PROFILE.childCharacters.length, 8); assert.equal(PROFILE.parentCharacters, 2_000_000);
  assert.equal(estimateStorage(pilot(), 450_000).batches, 192);
});
test('exactly three allocation windows select real warmup, baseline and final batches', () => {
  for (const mode of ['pilot', 'endurance']) for (const cadenceMs of [450_000, 900_000]) {
    const durationMs = mode === 'pilot' ? PROFILE.pilotBatches * cadenceMs : PROFILE.enduranceMs;
    const selected = []; let baselineTaken = false;
    for (let number = -1; number >= -PROFILE.warmupBatches; number--) {
      const label = allocationWindowLabel({ epoch: 'warmup', number });
      if (label) selected.push({ label, number });
    }
    let number = 0;
    for (let scheduledMs = 0; scheduledMs < durationMs; scheduledMs += cadenceMs) {
      const label = allocationWindowLabel({ mode, epoch: 'measurement', number: ++number,
        elapsedMs: scheduledMs, scheduledMs, durationMs, cadenceMs, baselineTaken, baselineStartMs: PROFILE.baselineStartMs });
      if (label) selected.push({ label, number, scheduledMs });
      if (label === 'hour-two') baselineTaken = true;
    }
    assert.deepEqual(selected.map(item => item.label), ['warmup', 'hour-two', 'final']);
    assert.equal(selected[0].number, -1);
    assert.equal(selected[1].scheduledMs, mode === 'pilot' ? 0 : PROFILE.baselineStartMs);
    assert.equal(selected[2].number, Math.ceil(durationMs / cadenceMs));
    assert.equal(selected[2].scheduledMs + cadenceMs, durationMs);
  }
});
test('allocation capture awaits readiness, proves batch overlap and rejects concurrent or idle windows', async () => {
  let ready, finish, now = 100, invoked = false; const records = [];
  const sampler = new BatchAllocationSampler(() => new Promise(resolve => { ready = resolve; }), record => records.push(record), () => now);
  const pending = sampler.run('warmup', 'warmup', -1, async () => { invoked = true; now = 110; return 'batch'; });
  assert.equal(invoked, false);
  await assert.rejects(sampler.run('final', 'measurement', 2, () => {}), /overlap/);
  ready({ startedAtMs: 99, done: new Promise(resolve => { finish = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invoked, true); assert.equal(records.length, 0);
  finish({ endedAtMs: 15_099, summary: { top: [], samplingInterval: 131_072, windowMs: 15_000 } });
  assert.equal(await pending, 'batch');
  assert.equal(records[0].batchOverlapMs, 10); assert.equal(records[0].actualDurationMs, 15_000);
  assert.equal(records[0].epoch, 'warmup'); assert.equal(records[0].batch, -1);
  await assert.rejects(sampler.run('warmup', 'warmup', -1, () => {}), /repeated/);
  const idle = new BatchAllocationSampler(async () => ({ startedAtMs: 0,
    done: Promise.resolve({ endedAtMs: 50, summary: {} }) }), () => assert.fail('Idle capture published'), () => now++);
  await assert.rejects(idle.run('final', 'measurement', 2, async () => {}), /did not overlap/);
});
test('plan binds pilot and supervisor completion, source revision, profile and two-platform reservation', () => {
  const p = pilot(), s = supervisor(); const plan = makePlan(p, s, 450_000);
  assert.equal(plan.combinedStorageBytes, 2 * (plan.storage.plannedBytes + p.disk.bytes));
  assert.equal(plan.requiredFreeBytes, plan.combinedStorageBytes + 20 * GiB);
  assert.deepEqual(validatePlan(plan, p, 'revision', s), plan.storage);
  for (const changed of [{ ...plan, sourceHead: 'other' }, { ...plan, platformRuns: 1 },
    { ...plan, profileSha256: 'wrong' }, { ...plan, combinedStorageBytes: plan.storage.plannedBytes },
    { ...plan, requiredFreeBytes: 0 }]) assert.throws(() => validatePlan(changed, p, 'revision', s));
  assert.throws(() => validatePlan(plan, p, 'revision', { ...s, completed: false }));
  assert.throws(() => makePlan({ ...p, completed: false }, s, 450_000));
  assert.throws(() => makePlan(p, undefined, 450_000));
  assert.throws(() => makePlanRaw(p, s, 450_000, p, s), /linux/);
  const peer = { ...p, platform: 'linux', disk: { bytes: 300 * MiB },
    batches: [{ diskBytesAdded: 130 * MiB, elapsedMs: 90_000 }, { diskBytesAdded: 140 * MiB, elapsedMs: 100_000 }] };
  const mixed = makePlanRaw(p, s, 450_000, peer, s);
  assert.equal(mixed.combinedStorageBytes, mixed.storage.plannedBytes + mixed.peerStorage.plannedBytes + p.disk.bytes + peer.disk.bytes);
  validatePlanRaw(mixed, p, 'revision', s, peer, s);
  assert.throws(() => validatePlanRaw(mixed, p, 'revision', s, { ...peer, harnessSha256: 'changed' }, s));
});
test('slow or oversized pilot cannot be waved into a cheaper or storage-unsafe cadence', () => {
  assert.throws(() => estimateStorage(pilot(), 1));
  assert.throws(() => estimateStorage(pilot(), 3_600_000));
  const slow = pilot(); slow.batches[0].elapsedMs = 400_000;
  assert.throws(() => estimateStorage(slow, 450_000));
  const large = pilot(); large.batches[0].diskBytesAdded = GiB;
  assert.throws(() => makePlan(large, supervisor(), 450_000));
});
test('drain windows require hours 2 through 23 and detect post-warmup growth without forced GC', () => {
  const windows = new DrainWindows();
  assert.throws(() => windows.result(true));
  for (let hour = 2; hour < 24; hour++) for (let n = 0; n < 3; n++) windows.add(hour * 3_600_000 + n * 1000,
    { heapUsed: 100 * MiB + hour * MiB, rss: 200 * MiB, external: 10 * MiB, arrayBuffers: MiB });
  assert.equal(windows.result(true).maxHeapGrowth, 21 * MiB);
  windows.hours.get(23).heapUsed = 500 * MiB;
  assert.throws(() => windows.result(true), /128 MiB/);
});
test('fixture history is deterministic, materialized and distinct by fresh identity', () => {
  const one = history('one', 1000), again = history('one', 1000), two = history('two', 1000);
  assert.equal(one.messages[0].content.length, 1000); assert.equal(one.sha256, again.sha256);
  assert.notEqual(one.sha256, two.sha256);
});
test('RSS and matching-sample combined growth fail even when individual component growth is below 128 MiB', () => {
  function populated() {
    const value = new DrainWindows();
    for (let hour = 2; hour < 24; hour++) for (let n = 0; n < 3; n++) value.add(hour * 3_600_000,
      { heapUsed: 100 * MiB, rss: 200 * MiB, external: 10 * MiB, arrayBuffers: MiB });
    return value;
  }
  const rss = populated(); rss.hours.get(23).rss += 129 * MiB;
  assert.throws(() => rss.result(true), /RSS/);
  const combined = populated();
  combined.hours.get(23).heapUsed += 80 * MiB; combined.hours.get(23).external += 80 * MiB;
  combined.hours.get(23).heapPlusExternal += 160 * MiB;
  assert.throws(() => combined.result(true), /Combined/);
  const matched = new DrainWindows();
  matched.add(7_200_000, { heapUsed: 10, external: 90, rss: 200, arrayBuffers: 1 });
  matched.add(7_200_001, { heapUsed: 90, external: 10, rss: 200, arrayBuffers: 1 });
  assert.equal(matched.hours.get(2).heapPlusExternal, 100);
  assert.equal(matched.hours.get(2).heapUsed + matched.hours.get(2).external, 20);
});
test('network guard blocks non-loopback transports and runtime child creation before side effects', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    require(process.argv[1]).installLoopbackGuard(12345);
    assert.throws(() => require('node:net').connect(443, 'example.com'), /blocked/);
    assert.throws(() => require('node:tls').connect(443, '127.0.0.1'), /blocked/);
    assert.throws(() => require('node:child_process').spawn('anything'), /blocked/);
  `, path.join(__dirname, 'network-guard.cjs')], { windowsHide: true });
});
test('evidence bounds and directory inventory do not silently truncate', async () => {
  const root = fs.mkdtempSync(path.join(process.env.FLUJO_QUALIFICATION_TEST_EVIDENCE ?? os.tmpdir(), 'flujo-memory-harness-'));
    const log = new BoundedJsonl(path.join(root, 'records.jsonl'), 30);
    log.write({ count: 1 }); assert.throws(() => log.write({ content: 'x'.repeat(40) })); log.close(); log.close();
    assert.equal((await directoryBytes(root)).files, 1);
    assert(inside(root, path.join(root, 'records.jsonl'))); assert(!inside(root, path.join(root, '..', 'elsewhere')));
  // Preserve fixtures for owner-directed flujo-bash cleanup after settlement.
});
test('real bounded loopback provider has deterministic retries, fixed counters, auth and no retained bodies', async () => {
  const provider = createProvider('fixture-token');
  await new Promise(resolve => provider.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + provider.server.address().port;
  const call = (url, options = {}) => fetch(origin + url, { ...options, headers: { authorization: 'Bearer fixture-token' } });
  try {
    assert.equal((await fetch(origin + '/control/status')).status, 403);
    await (await call('/control/next-batch', { method: 'POST' })).text();
    for (const status of [429, 200]) {
      const response = await call('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'retry-control', messages: [] }) });
      assert.equal(response.status, status); await response.text();
    }
    const failed = await call('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'child-3' }) });
    assert.equal(failed.status, 400); assert.equal((await failed.json()).error.code, TERMINAL_CODE);
    const stream = await call('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'parent', stream: true }) });
    assert.match(await stream.text(), /data: \[DONE\]/);
    const status = await (await call('/control/status')).json();
    assert.equal(status.active, 0); assert.equal(status.counts['retry-control'], 2); assert.equal(status.totalRequests, 4);
    assert.equal(status.outcomes['retry-control'].retryMarker, RETRY_MARKER);
    assert.equal(status.outcomes['child-3'].terminalMarker, TERMINAL_MARKER);
    assert.equal(Object.keys(status.counts).length, 15);
  } finally { await provider.close(); }
});
test('loopback provider caps simultaneous physical requests and rejects counter reset while active', async () => {
  const provider = createProvider('token');
  await new Promise(resolve => provider.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + provider.server.address().port;
  const request = (url, method = 'POST') => fetch(origin + url, { method, headers: { authorization: 'Bearer token' },
    ...(method === 'POST' && url.includes('completions') ? { body: JSON.stringify({ model: 'live-control' }) } : {}) });
  const pending = Array.from({ length: 4 }, () => request('/v1/chat/completions').then(response => response.text()));
  try {
    const deadline = performance.now() + 3000;
    while (provider.receipt().active !== 4) { assert(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
    // Cross the former automatic five-second release. Time must not turn the
    // disconnected-owner control into a completed request.
    await new Promise(resolve => setTimeout(resolve, 5100));
    assert.equal(provider.receipt().held, 4); assert.equal(provider.receipt().active, 4);
    assert.equal(provider.receipt().outcomes['live-control'].success, 0);
    const rejected = await request('/v1/chat/completions'); assert.equal(rejected.status, 503); await rejected.text();
    const reset = await request('/control/next-batch'); assert.equal(reset.status, 409); await reset.text();
    await (await request('/control/release')).text(); await Promise.all(pending);
    assert.equal(provider.receipt().peakActive, 4); assert.equal(provider.receipt().active, 0);
  } finally { await provider.close(); await Promise.allSettled(pending); }
});

test('canonical manifests normalize line endings and bind both platforms, file sets and dependencies', () => {
  assert.equal(canonicalTextHash('one\r\ntwo\r\n'), canonicalTextHash('one\ntwo\n'));
  const p = pilot(), s = supervisor(), peer = { ...pilot(), platform: 'linux' };
  const plan = makePlanRaw(p, s, 450_000, peer, s);
  assert.equal(plan.sourceManifestSha256, sourceManifestHash(p.source));
  for (const changed of [
    { ...peer, source: undefined },
    { ...peer, node: 'v24.22.1' },
    { ...peer, source: { ...source(), files: { 'src/runtime.ts': canonicalTextHash('different') } } },
    { ...peer, source: { ...source(), files: { ...source().files, 'src/extra.ts': canonicalTextHash('extra') } } },
    { ...peer, source: { ...source(), openaiEntrySha256: canonicalTextHash('other sdk') } },
    { ...peer, source: { ...source(), importBridge: { ...bridgeFixture(), exportsSha256: hash('changed exports') } } },
  ]) assert.throws(() => makePlanRaw(p, s, 450_000, changed, s));
  assert.throws(() => validatePlanRaw({ ...plan, source: { ...source(), lockSha256: canonicalTextHash('changed') } },
    p, 'revision', s, peer, s));
  assert.throws(() => sourceManifestHash({ ...source(), files: { 'src/../outside.ts': canonicalTextHash('bad') } }));
});

test('launch preflight compares actual canonical files and installed dependency entries with pilot manifest', () => {
  const root = fs.mkdtempSync(path.join(process.env.FLUJO_QUALIFICATION_TEST_EVIDENCE ?? os.tmpdir(), 'flujo-source-manifest-'));
  for (const directory of ['src', 'node_modules/typescript', 'node_modules/openai', 'node_modules/@modelcontextprotocol/ext-tasks']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), 'lock\r\n');
  fs.writeFileSync(path.join(root, 'src/runtime.ts'), 'runtime\r\n');
  fs.writeFileSync(path.join(root, 'node_modules/typescript/package.json'), JSON.stringify({ version: 'fixture-version' }));
  fs.writeFileSync(path.join(root, 'node_modules/openai/index.js'), 'sdk\r\n');
  const bridgeRoot = path.join(root, 'node_modules/@modelcontextprotocol/ext-tasks');
  fs.writeFileSync(path.join(bridgeRoot, 'package.json'), JSON.stringify(bridgeMetadata));
  for (const entry of Object.values(bridgeMetadata.exports)) fs.writeFileSync(path.join(bridgeRoot, entry.import), bridgeSource);
  verifySourceManifest(root, root, source());
  fs.writeFileSync(path.join(bridgeRoot, 'core.js'), 'export const value = 2;\n');
  assert.throws(() => verifySourceManifest(root, root, source()), /do not match/);
  fs.writeFileSync(path.join(bridgeRoot, 'core.js'), bridgeSource);
  fs.writeFileSync(path.join(root, 'src/runtime.ts'), 'changed\n');
  assert.throws(() => verifySourceManifest(root, root, source()), /do not match/);
});

test('settlement rejects quarantined scanners, leaked output owners and missing public counters', () => {
  const d = { flow: { activeRuns: 0, reservedBytes: 0, activeWorkspaces: 0, workspaceActiveRuns: 0,
    workspaceReservedBytes: 0, workspaceConversations: 0 }, subflowPreparation: { active: 0, reservedBytes: 0 },
    subflowOutput: { active: 0, reservedBytes: 0 }, archive: { bytes: 0, writers: 0, quarantined: 0 },
    archiveRead: { activeReads: 0, quarantinedReads: 0, reservedJsonAllocationBytes: 0, cleanupFailures: 0 },
    cache: { inFlightLoads: 0 }, publication: { owners: 0, writers: 0, allocationBytes: 0, retainedBytes: 0,
      queuedWriters: 0, chains: 0, fences: 0, receipts: 0, quarantinedWriterSlots: 0, terminalWaiters: 0, rejected: 7 },
    ingress: { active: 0, parsing: 0, reservedBytes: 0, rejectedSize: 3 },
    allocation: { run: 0, preparation: 0, output: 0, ingress: 0, publication: 0, total: 0 },
    rate: { keys: 1, keyBytes: 128, maxKeys: 4096, maxKeyBytes: 1048576, capacityRefusals: 0, rateRefusals: 0, expired: 20 }, streams: { active: 0, replayReads: 0, workspaces: 0, conversations: 0 },
    gate: { activeMutations: 0, blocked: false }, sequence: { keys: 4, keyBytes: 512, maxKeys: 4096, maxTotalKeyBytes: 4194304,
      scanActive: 0, scanQuarantined: 0, pendingAppendChains: 0, pendingCommitConversations: 0, pendingCommits: 0,
      rejectedNewKeys: 0, scanRefusals: 0 }, sessions: 0, cancellable: 0, conversationLocks: 0 };
  assertSettledDiagnostics(d);
  for (const [group, field] of [['sequence', 'scanQuarantined'], ['sequence', 'scanActive'], ['sequence', 'pendingCommits'],
    ['subflowOutput', 'active'], ['subflowOutput', 'reservedBytes'], ['streams', 'conversations'],
    ...['owners', 'writers', 'allocationBytes', 'retainedBytes', 'queuedWriters', 'chains', 'fences', 'receipts', 'quarantinedWriterSlots', 'terminalWaiters'].map(f => ['publication', f]),
    ...['active', 'parsing', 'reservedBytes'].map(f => ['ingress', f]),
    ...['run', 'preparation', 'output', 'ingress', 'publication', 'total'].map(f => ['allocation', f]),
    ['archiveRead', 'reservedJsonAllocationBytes'], ['archiveRead', 'cleanupFailures'], ['cache', 'inFlightLoads']]) {
    assert.throws(() => assertSettledDiagnostics({ ...d, [group]: { ...d[group], [field]: 1 } }));
    const missing = { ...d[group] }; delete missing[field];
    assert.throws(() => assertSettledDiagnostics({ ...d, [group]: missing }));
  }
  assert.throws(() => assertSettledDiagnostics({ ...d, gate: { ...d.gate, blocked: true } }));
  for (const field of ['keys', 'keyBytes', 'capacityRefusals', 'rateRefusals']) {
    assert.throws(() => assertSettledDiagnostics({ ...d, rate: { ...d.rate, [field]: 9999999 } }));
    const missing = { ...d.rate }; delete missing[field];
    assert.throws(() => assertSettledDiagnostics({ ...d, rate: missing }));
  }
  assert.throws(() => assertSettledDiagnostics({ ...d, sequence: { ...d.sequence, keys: 4097 } }));
});

test('child outcomes reject missing dispatch, arbitrary errors, wrong retry counts and wrong markers', () => {
  const empty = { success: 0, retry429: 0, permanent400: 0, terminalMarker: '', retryMarker: '', completionMarker: '' };
  const provider = (index, count, outcome = empty) => ({ batch: 7, counts: { ['child-' + index]: count }, outcomes: { ['child-' + index]: outcome } });
  const refused = { status: 'error', lastResponse: { errorDetails: { code: 'MODEL_TURN_ARCHIVE_MEMORY_LIMIT' } } };
  const failedLane = { status: 'error', error: 'typed archive refusal' };
  assert.equal(assertChildOutcome(5, failedLane, refused, provider(5, 0), 0).kind, 'pre-sdk-archive-refusal');
  assert.throws(() => assertChildOutcome(5, failedLane, { ...refused, lastResponse: { errorDetails: { code: 'arbitrary_error' } } }, provider(5, 0), 0));
  assert.throws(() => assertChildOutcome(5, failedLane, refused, provider(5, 0), 1));
  const permanent = { status: 'error', lastResponse: { error: TERMINAL_MARKER, errorDetails: { code: TERMINAL_CODE } } };
  const p400 = provider(3, 1, { ...empty, permanent400: 1, terminalMarker: TERMINAL_MARKER });
  assert.equal(assertChildOutcome(3, { status: 'error', error: TERMINAL_MARKER }, permanent, p400, 1).kind, 'permanent-400');
  assert.throws(() => assertChildOutcome(3, { status: 'error', error: 'unrelated' }, permanent, p400, 1));
  for (const index of [4, 5, 6, 7]) {
    const marker = 'completed child-' + index + ' batch 7';
    const lane = { status: 'completed', outputText: marker }, state = { status: 'completed', messages: [{ role: 'assistant', content: marker }] };
    const good = provider(index, index === 4 ? 2 : 1, { ...empty, success: 1, retry429: index === 4 ? 1 : 0,
      retryMarker: index === 4 ? RETRY_MARKER : '', completionMarker: marker });
    assertChildOutcome(index, lane, state, good, 1);
    assert.throws(() => assertChildOutcome(index, { ...lane, outputText: 'wrong batch' }, state, good, 1));
    assert.throws(() => assertChildOutcome(index, lane, state, { ...good, counts: { ['child-' + index]: 0 } }, 1));
    assert.throws(() => assertChildOutcome(index, lane, state, good, 0));
  }
});

test('durable fold identity rejects joined, duplicate, changed child identity and unacknowledged continuation', () => {
  const expected = { id: 'invocation', parentNodeId: 'subflow', lanes: [0, 1].map(index =>
    ({ id: 'lane-' + index, conversationId: 'child-' + index, subflowId: 'flow-' + index, status: 'completed' })) };
  const ids = [0, 1].map(index => 'invocation:fold:v1:separate:' + index);
  const state = { variables: {}, lastResponse: 'result', activeSubflowInvocationByNode: {}, subflowInvocations: {
    invocation: { ...expected, status: 'folded', foldedAt: 1, resultPresentation: 'separate', foldReceipt: {
      version: 1, id: 'invocation:fold:v1', presentation: 'separate', action: 'done', continuedAt: 2, messageIds: ids } } },
    messages: expected.lanes.map((lane, index) => ({ id: ids[index], role: 'assistant', processNodeId: 'subflow', content: 'result',
      subflowResult: { conversationId: lane.conversationId, subflowId: lane.subflowId, laneIndex: index, laneCount: 2, status: 'completed' } })) };
  const identity = foldIdentity(state, expected);
  assert.deepEqual(foldIdentity(JSON.parse(JSON.stringify(state)), expected), identity);
  for (const mutate of [copy => { copy.subflowInvocations.invocation.foldReceipt.presentation = 'joined'; },
    copy => { copy.messages.push(copy.messages[0]); }, copy => { copy.messages[0].subflowResult.conversationId = 'other'; },
    copy => { delete copy.subflowInvocations.invocation.foldReceipt.continuedAt; }]) {
    const copy = structuredClone(state); mutate(copy); assert.throws(() => foldIdentity(copy, expected));
  }
});

 test('plans require outer MCP, guard, guardian and physical disk settlement', () => {
  const p = pilot(), peer = { ...p, platform: 'linux' }, s = supervisor();
  const owner = ownership(p, s), other = ownership(peer, s);
  const plan = makePlanBound(p, s, 450000, peer, s, owner, other);
  for (const mutate of [o => { o.completed = false; }, o => { o.equipmentOnly = true; }, o => { o.mcp.serverExitCode = 1; }, o => { o.guard.jobActiveProcesses = 1; }, o => { o.mcp.stderrEnded = false; },
    o => { o.mcp.serverExited = false; }, o => { o.guard.stdoutEnded = false; },
    o => { o.guard.minimumHostDiskFreeBytes = 1; }, o => { o.guard.diskAdmissions = []; },
    o => { o.linux.forcedCleanup = true; }, o => { o.guard.forcedCleanup = true; },
    o => { o.supervisor.processes.windowsJob.forcedCleanup = true; },
    o => { o.linux.beforeCleanupMembers = [{pid:123}]; }, o => { o.linux.remainingWorkloadMembers = [{ pid: 123 }]; },
    o => { o.linux.aggregateCgroup = '/unrelated'; }]) {
    const changed = structuredClone(other); mutate(changed);
    assert.throws(() => makePlanBound(p, s, 450000, peer, s, owner, changed));
  }
  assert.throws(() => makePlanBound(p, s, 450000, peer, s));
  assert.throws(() => makePlanBound(p, s, 450000, peer, s, owner, { ...other, launcherSha256: 'b'.repeat(64) }));
  assert.throws(() => validatePlanBound({ ...plan, pilotOwnershipSha256: 'wrong' }, p, 'revision', s, peer, s, owner, other));
 });

test('current executable and helper identity are bound to the concrete plan before launch', () => {
  const p=pilot(), s=supervisor(), plan=makePlan(p,s,450000);
  validateLaunchIdentity(plan,p.node,'a'.repeat(64));
  assert.throws(() => validateLaunchIdentity(plan,'v24.22.1','a'.repeat(64)), /Current Node/);
  assert.throws(() => validateLaunchIdentity(plan,p.node,'b'.repeat(64)), /Current launch equipment/);
  assert.throws(() => validatePlan({ ...plan, expectedNode:'v24.22.1' },p,'revision',s));
  assert.throws(() => validatePlan({ ...plan, launcherSha256:'b'.repeat(64) },p,'revision',s));
});

test('Linux plan inputs verify independently attested mirror bytes and ext4 provenance', () => {
  const directory=fs.mkdtempSync(path.join(process.env.FLUJO_QUALIFICATION_TEST_EVIDENCE??os.tmpdir(),'flujo-mirror-'));
  const p={...pilot(),platform:'linux'}, s=supervisor(), owner=ownership(p,s);
  const values={'runtime-receipt.json':p,'supervisor-receipt.json':s,'runtime-settled.json':{completed:true},'provider-settled.json':{active:0}};
  for(const name of receiptNames){
    const bytes=Buffer.from(JSON.stringify(values[name])+'\n');fs.writeFileSync(path.join(directory,name),bytes);
    owner.linux.datasetMirror.files[name]={bytes:bytes.length,sha256:hash(bytes),sourcePath:datasetFilesystem().path+'/'+name};
  }
  owner.guard.datasetMirror=structuredClone(owner.linux.datasetMirror);
  const ownerFile=path.join(directory,'ownership-receipt.json');fs.writeFileSync(ownerFile,JSON.stringify(owner));
  assert.equal(readPilotEvidence(directory).pilot.completed,true);
  fs.appendFileSync(path.join(directory,'runtime-receipt.json'),' ');
  assert.throws(() => readPilotEvidence(directory),/Attested mirror/);
  fs.writeFileSync(path.join(directory,'runtime-receipt.json'),JSON.stringify(p)+'\n');
  // Hash-correct old receipts copied to a new ext4 inode still cannot qualify.
  owner.linux.datasetMirror.datasetFilesystem.inode++;
  owner.guard.datasetMirror=structuredClone(owner.linux.datasetMirror);fs.writeFileSync(ownerFile,JSON.stringify(owner));
  assert.throws(() => readPilotEvidence(directory), /inode/);
  owner.linux.datasetMirror.datasetFilesystem.inode--;
  owner.linux.datasetMirror.datasetFilesystem.filesystemMagic='0x9fa0';
  owner.guard.datasetMirror=structuredClone(owner.linux.datasetMirror);fs.writeFileSync(ownerFile,JSON.stringify(owner));
  assert.throws(() => readPilotEvidence(directory),/0xef53/);
});
