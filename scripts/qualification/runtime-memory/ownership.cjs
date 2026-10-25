'use strict';
const assert = require('node:assert/strict');
function assertOwnership(owner, pilot, supervisor) {
  assert.equal(owner?.completed, true, 'Final outer ownership receipt is required');
  assert.equal(owner.equipmentOnly, false, 'Equipment is not an application pilot');
  assert.match(owner.launcherSha256, /^[a-f0-9]{64}$/);
  assert.equal(owner.platform, pilot.platform);
  assert.deepEqual(owner.supervisor, supervisor, 'Outer receipt must bind the actual supervisor result');
  for (const field of ['sourceHead', 'profileSha256', 'harnessSha256']) assert.equal(supervisor[field], pilot[field]);
  for (const field of ['serverExited', 'stderrEnded', 'transportClosed']) assert.equal(owner.mcp?.[field], true, 'MCP owner did not settle');
  assert.equal(owner.mcp.resultError, false);
  assert.equal(owner.mcp.serverExitCode, 0); assert.equal(owner.mcp.serverExitSignal, null);
  const guard = owner.guard;
  assert.equal(guard?.completed, true); assert.equal(guard.childExitCode, 0);
  for (const field of ['stdoutEnded', 'stderrEnded', 'copyThreadsStopped']) assert.equal(guard[field], true);
  assert.deepEqual(guard.errors, []); assert.equal(guard.stoppedByGuard, null);
  assert.equal(guard.jobActiveProcesses, 0, 'Outer job retained descendants');
  assert.equal(guard.hostBackingVolume, 'C:\\');
  assert.equal(guard.diskFloorBytes, 20 * 1024 ** 3);
  assert(guard.minimumHostDiskFreeBytes >= guard.diskFloorBytes);
  assert.equal(supervisor.diskAdmissions?.length, 2, 'Both child launches need fresh disk admission');
  assert.deepEqual(guard.diskAdmissions, supervisor.diskAdmissions);
  for (const receipt of supervisor.diskAdmissions) {
    assert.equal(receipt.kind, 'windows-physical-volume-v1'); assert.equal(receipt.volume, 'C:\\');
    assert.equal(receipt.admitted, true); assert(receipt.freeBytes >= receipt.request.requiredFreeBytes);
    assert.equal(receipt.request.requiredFreeBytes, 22 * 1024 ** 3, 'Pilot disk reservation changed');
    assert.equal(receipt.request.mode, 'pilot'); assert.equal(receipt.request.planSha256, null);
    for (const field of ['sourceHead', 'profileSha256', 'harnessSha256']) assert.equal(receipt.request[field], pilot[field]);
  }
  if (pilot.platform === 'linux') {
    assert.equal(owner.linux?.reason, 'command completed'); assert.equal(owner.linux.childExitCode, 0);
    assert.deepEqual(owner.linux.remainingWorkloadMembers, []);
    assert.match(owner.linux.workloadCgroupEvents, /(?:^|\n)populated 0(?:\n|$)/);
    assert.equal(owner.linux.aggregateCgroup, supervisor.envelope.path);
    assert.equal(owner.linux.workloadCgroup, supervisor.envelope.workloadPath);
    assert.equal(supervisor.envelope.guardianIncluded, true);
  }
}
module.exports = { assertOwnership };
