#!/usr/bin/env node
'use strict';
// Produce a concrete plan; this command never starts a workload.
const { assertOwnership } = require('./ownership.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { PROFILE, profileSha256, harnessDigest, readPilotEvidence, hash, estimateStorage, matchingPilotSource } = require('./profile.cjs');
function makePlan(pilot, supervisor, cadenceMs, peerPilot, peerSupervisor, owner, peerOwner) {
  assertOwnership(owner, pilot, supervisor); assertOwnership(peerOwner, peerPilot, peerSupervisor);
  assert.equal(owner.launcherSha256, peerOwner.launcherSha256, 'Platform launch equipment changed');
  assert.equal(pilot.completed, true); assert.equal(pilot.mode, 'pilot');
  assert.equal(pilot.profileSha256, profileSha256);
  assert.equal(pilot.harnessSha256, harnessDigest());
  assert.equal(supervisor?.completed, true, 'Independent process/stdio settlement is required');
  assert.equal(supervisor.sourceHead, pilot.sourceHead);
  assert.equal(supervisor.profileSha256, profileSha256);
  assert.equal(supervisor.harnessSha256, harnessDigest());
  assert.equal(peerPilot?.completed, true); assert.equal(peerPilot.mode, 'pilot');
  assert.equal(peerPilot.sourceHead, pilot.sourceHead); assert.equal(peerPilot.profileSha256, profileSha256);
  assert.equal(peerPilot.harnessSha256, harnessDigest());
  assert.equal(peerSupervisor?.completed, true); assert.equal(peerSupervisor.sourceHead, pilot.sourceHead);
  assert.equal(peerSupervisor.profileSha256, profileSha256);
  assert.equal(peerSupervisor.harnessSha256, harnessDigest());
  assert.deepEqual([pilot.platform, peerPilot.platform].sort(), ['linux', 'win32']);
  const sourceManifestSha256 = matchingPilotSource(pilot, peerPilot);
  const storage = estimateStorage(pilot, cadenceMs);
  const peerStorage = estimateStorage(peerPilot, cadenceMs);
  const combinedStorageBytes = storage.plannedBytes + peerStorage.plannedBytes + pilot.disk.bytes + peerPilot.disk.bytes;
  assert(combinedStorageBytes <= PROFILE.budgets.maximumPlannedBytes, 'Two platform runs plus preserved pilots exceed suite allowance');
  return { version: PROFILE.version, profileSha256, sourceHead: pilot.sourceHead, sourceManifestSha256, source: pilot.source,
    expectedNode: pilot.node, launcherSha256: owner.launcherSha256,
    pilotSha256: hash(JSON.stringify(pilot)), pilotSupervisorSha256: hash(JSON.stringify(supervisor)),
    peerPilotSha256: hash(JSON.stringify(peerPilot)), peerSupervisorSha256: hash(JSON.stringify(peerSupervisor)),
    pilotOwnershipSha256: hash(JSON.stringify(owner)), peerOwnershipSha256: hash(JSON.stringify(peerOwner)),
    cadenceMs, storage, peerStorage, platformRuns: 2, combinedStorageBytes,
    requiredFreeBytes: combinedStorageBytes + PROFILE.budgets.minimumFreeBytes,
    note: 'Reserve both platform runs and two pilot data sets together. No execution is launched by plan generation.' };
}
if (require.main === module) {
  const [pilotDirectory, peerDirectory, planFile, cadence] = process.argv.slice(2);
  if (!pilotDirectory || !peerDirectory || !planFile) throw new Error('Usage: node plan.cjs PILOT_DIRECTORY OTHER_PLATFORM_PILOT_DIRECTORY NEW_PLAN_FILE [CADENCE_MS]');
  const target = readPilotEvidence(pilotDirectory), peer = readPilotEvidence(peerDirectory);
  fs.writeFileSync(planFile, JSON.stringify(makePlan(target.pilot, target.supervisor, Number(cadence ?? PROFILE.candidateCadenceMs),
    peer.pilot, peer.supervisor, target.owner, peer.owner), null, 2), { flag: 'wx' });
}
module.exports = { makePlan };
