'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { assertOwnership } = require('./ownership.cjs');
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
// Change the version, rerun the pilot and review a new plan if these change.
const PROFILE = Object.freeze({
  version: 'runtime-memory-v1', workspace: 'default-workspace',
  parentCharacters: 2_000_000,
  childCharacters: [3_600_000, 4_000_000, 4_400_000, 4_800_000, 5_200_000, 5_600_000, 3_800_000, 4_200_000],
  maxActiveChildren: 4, pilotBatches: 2, candidateCadenceMs: 450_000,
  warmupBatches: 2, parkedHoldMs: 31 * 60_000,
  enduranceMs: 24 * 60 * 60_000, baselineStartMs: 2 * 60 * 60_000,
  finalWindowMs: 60 * 60_000, drainMs: 31 * 60_000, batchDeadlineMs: 10 * 60_000,
  sampleMs: 10_000, inspectorInterval: 131_072, inspectorWindowMs: 15_000,
  maxInspectorBytes: 16 * MiB, maxEvidenceFileBytes: 64 * MiB,
  budgets: { cpus: 2, aggregateBytes: 2 * GiB, appRss: GiB, providerRss: 384 * MiB,
    retainedGrowth: 128 * MiB, minimumFreeBytes: 20 * GiB, maximumPlannedBytes: 120 * GiB },
  provider: { maxActive: 4, maxBodyBytes: 12 * MiB, maxSockets: 12, requestTimeoutMs: 30_000 },
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonicalTextHash = value => hash(value.toString().replaceAll('\r\n', '\n'));
function sourceManifestHash(source) {
  assert.equal(source?.format, 'source-lf-v1', 'Canonical source manifest is required');
  const files = Object.entries(source.files ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert(files.length > 0 && files.length <= 4096, 'Invalid source manifest size');
  for (const [file, digest] of files) {
    assert(/^src\/.+\.tsx?$/.test(file) && !/[\\:\0]/.test(file)
      && file.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid source manifest path');
    assert(/^[a-f0-9]{64}$/.test(digest), 'Invalid source hash');
  }
  for (const key of ['openaiEntrySha256', 'lockSha256']) assert(/^[a-f0-9]{64}$/.test(source[key]), 'Invalid dependency hash');
  assert.equal(typeof source.typescript, 'string'); assert(source.typescript.length > 0);
  return hash(JSON.stringify({ format: source.format, files, typescript: source.typescript,
    openaiEntrySha256: source.openaiEntrySha256, lockSha256: source.lockSha256 }));
}
function matchingPilotSource(pilot, peer) {
  assert.match(pilot.node, /^v\d+\.\d+\.\d+$/);
  assert.equal(pilot.node, peer.node, 'Platform Node versions differ');
  const digest = sourceManifestHash(pilot.source);
  assert.equal(sourceManifestHash(peer.source), digest, 'Platform canonical source/dependency manifests differ');
  return digest;
}
const profileSha256 = hash(JSON.stringify(PROFILE));
function harnessDigest() {
  const files = ['profile.cjs', 'provider.cjs', 'source-loader.cjs', 'network-guard.cjs', 'fixtures.cjs',
    'evidence.cjs', 'checks.cjs', 'runtime.cjs', 'plan.cjs', 'supervise.py', 'envelope_evidence.py', 'ownership.cjs'];
  return hash(JSON.stringify(files.map(file => [file, hash(fs.readFileSync(path.join(__dirname, file), 'utf8').replaceAll('\r\n', '\n'))])));
}
function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function readJson(file, maximum = MiB) {
  assert(fs.statSync(file).size <= maximum, 'JSON receipt exceeds allowance');
  const bytes = fs.readFileSync(file);
  assert(bytes.length <= maximum, 'JSON receipt grew beyond allowance');
  return JSON.parse(bytes.toString('utf8'));
}
function estimateStorage(pilot, cadenceMs) {
  assert(Number.isSafeInteger(cadenceMs) && cadenceMs >= PROFILE.candidateCadenceMs && cadenceMs <= 15 * 60_000,
    'Cadence must allow at least three drained samples per hour and not exceed candidate load rate');
  assert(Array.isArray(pilot.batches) && pilot.batches.length === PROFILE.pilotBatches);
  const maximumBatchBytes = Math.max(...pilot.batches.map(batch => {
    assert(Number.isSafeInteger(batch.diskBytesAdded) && batch.diskBytesAdded > 0);
    assert(Number.isFinite(batch.elapsedMs) && batch.elapsedMs > 0);
    return batch.diskBytesAdded;
  }));
  assert(cadenceMs >= Math.max(...pilot.batches.map(batch => batch.elapsedMs)) * 1.25,
    'Cadence needs 25% headroom above the slowest pilot batch');
  const batches = Math.ceil(PROFILE.enduranceMs / cadenceMs);
  return { cadenceMs, batches, maximumBatchBytes,
    // All histories/archives remain on disk. Include 50% growth margin and 2 GiB evidence/setup.
    plannedBytes: Math.ceil(maximumBatchBytes * batches * 1.5) + 2 * GiB };
}
function validatePlan(plan, pilot, sourceHead, supervisor, peerPilot, peerSupervisor, owner, peerOwner) {
  assertOwnership(owner, pilot, supervisor); assertOwnership(peerOwner, peerPilot, peerSupervisor);
  assert.equal(owner.launcherSha256, peerOwner.launcherSha256, 'Platform launch equipment changed');
  assert.equal(plan.expectedNode, pilot.node);
  assert.equal(plan.launcherSha256, owner.launcherSha256);
  assert.equal(plan.pilotOwnershipSha256, hash(JSON.stringify(owner)));
  assert.equal(plan.peerOwnershipSha256, hash(JSON.stringify(peerOwner)));
  assert.equal(plan.version, PROFILE.version);
  assert.equal(plan.profileSha256, profileSha256);
  assert.equal(plan.sourceHead, sourceHead);
  assert.equal(pilot.sourceHead, sourceHead);
  assert.equal(pilot.profileSha256, profileSha256);
  assert.equal(pilot.harnessSha256, harnessDigest(), 'Harness changed after the pilot');
  assert.equal(pilot.mode, 'pilot');
  assert.equal(pilot.completed, true);
  assert.equal(supervisor?.completed, true, 'Pilot needs independent process/stdio settlement');
  assert.equal(supervisor.sourceHead, sourceHead);
  assert.equal(supervisor.profileSha256, profileSha256);
  assert.equal(supervisor.harnessSha256, harnessDigest());
  assert.equal(plan.pilotSupervisorSha256, hash(JSON.stringify(supervisor)));
  assert.equal(plan.pilotSha256, hash(JSON.stringify(pilot)));
  const storage = estimateStorage(pilot, plan.cadenceMs);
  assert.deepEqual(plan.storage, storage);
  assert.equal(plan.platformRuns, 2, 'Reserve Windows and Linux together');
  assert.equal(peerPilot?.completed, true); assert.equal(peerPilot.mode, 'pilot');
  assert.equal(peerPilot.sourceHead, sourceHead); assert.equal(peerPilot.profileSha256, profileSha256);
  assert.equal(peerPilot.harnessSha256, harnessDigest());
  assert.equal(peerSupervisor?.completed, true); assert.equal(peerSupervisor.sourceHead, sourceHead);
  assert.equal(peerSupervisor.profileSha256, profileSha256);
  assert.equal(peerSupervisor.harnessSha256, harnessDigest());
  assert.deepEqual([pilot.platform, peerPilot.platform].sort(), ['linux', 'win32']);
  assert.equal(plan.sourceManifestSha256, matchingPilotSource(pilot, peerPilot));
  assert.equal(sourceManifestHash(plan.source), plan.sourceManifestSha256, 'Plan source manifest changed');
  assert.equal(plan.peerPilotSha256, hash(JSON.stringify(peerPilot)));
  assert.equal(plan.peerSupervisorSha256, hash(JSON.stringify(peerSupervisor)));
  const peerStorage = estimateStorage(peerPilot, plan.cadenceMs);
  assert.deepEqual(plan.peerStorage, peerStorage);
  assert(Number.isSafeInteger(pilot.disk.bytes) && pilot.disk.bytes > 0);
  assert(Number.isSafeInteger(peerPilot.disk.bytes) && peerPilot.disk.bytes > 0);
  assert.equal(plan.combinedStorageBytes, storage.plannedBytes + peerStorage.plannedBytes + pilot.disk.bytes + peerPilot.disk.bytes);
  assert.equal(plan.requiredFreeBytes, plan.combinedStorageBytes + PROFILE.budgets.minimumFreeBytes);
  assert(plan.combinedStorageBytes <= PROFILE.budgets.maximumPlannedBytes, 'Combined platform runs and pilots exceed fixed disk allowance');
  return storage;
}
function validateLaunchIdentity(plan, node, launcherSha256) {
  assert.match(plan.expectedNode, /^v\d+\.\d+\.\d+$/);
  assert.match(plan.launcherSha256, /^[a-f0-9]{64}$/);
  assert.equal(node, plan.expectedNode, 'Current Node differs from the successful pilots');
  assert.equal(launcherSha256, plan.launcherSha256, 'Current launch equipment differs from the successful pilots');
}
module.exports = { PROFILE, profileSha256, harnessDigest, MiB, GiB, hash, canonicalTextHash, sourceManifestHash,
  matchingPilotSource, inside, readJson, estimateStorage, validatePlan, validateLaunchIdentity };
