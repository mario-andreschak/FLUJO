'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
function assertOwnership(owner, pilot, supervisor) {
  assert.equal(owner?.completed, true, 'Final outer ownership receipt is required');
  assert.equal(owner.equipmentOnly, false, 'Equipment is not an application pilot');
  assert.equal(pilot.equipmentOnly, false, 'Equipment runtime cannot qualify'); assert.equal(pilot.qualification, true);
  assert.equal(supervisor.equipmentOnly, false, 'Equipment controller cannot qualify'); assert.equal(supervisor.qualification, true);
  assert.match(owner.launcherSha256, /^[a-f0-9]{64}$/);
  assert.equal(owner.platform, pilot.platform);
  assert.deepEqual(owner.supervisor, supervisor, 'Outer receipt must bind the actual supervisor result');
  for (const field of ['sourceHead', 'profileSha256', 'harnessSha256']) assert.equal(supervisor[field], pilot[field]);
  assert.deepEqual(pilot.bootstrap, supervisor.bootstrap, 'Runtime and supervisor bootstrap evidence differ');
  const bootstrap = supervisor.bootstrap;
  assert.equal(bootstrap?.version, 'runtime-bootstrap-v1'); assert.match(bootstrap.nonce, /^[a-f0-9]{48}$/);
  assert(Number.isSafeInteger(bootstrap.pid) && bootstrap.pid > 0);
  assert.equal(bootstrap.identity.pid, bootstrap.pid);
  assert.match(bootstrap.identity.processInstanceId, /^[a-f0-9-]{36}$/);
  assert.match(bootstrap.identity.processBirthMarkerV2, pilot.platform === 'win32' ? /^win32-v2:[1-9][0-9]*$/ : /^linux-v2:[a-f0-9-]+:[0-9]+$/);
  for (const field of ['sourceHead', 'profileSha256', 'harnessSha256']) assert.equal(bootstrap[field], pilot[field]);
  assert.match(bootstrap.sourceManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(bootstrap.settlement.sealed, true);
  assert(bootstrap.settlement.probes.length <= 3 && (pilot.platform !== 'win32' || bootstrap.settlement.probes.length > 0));
  for (const probe of bootstrap.settlement.probes) {
    assert.equal(probe.closed, true); assert.equal(probe.exitCode, 0); assert.equal(probe.signal, null); assert.equal(probe.killed, false);
    assert.equal(probe.stdoutEnded, true); assert.equal(probe.stderrEnded, true);
  }
  assert.equal(supervisor.bootstrapAdmission?.runtimeOnly, true);
  assert.equal(supervisor.bootstrapAdmission.runtimePid, bootstrap.pid);
  if (pilot.platform === 'win32') assert.equal(supervisor.bootstrapAdmission.jobActiveProcesses, 1);
  else assert.deepEqual([...supervisor.bootstrapAdmission.workloadMembers].sort((a, b) => a - b),
    [supervisor.bootstrapAdmission.supervisorPid, bootstrap.pid].sort((a, b) => a - b));
  for (const field of ['serverExited', 'stderrEnded', 'transportClosed']) assert.equal(owner.mcp?.[field], true, 'MCP owner did not settle');
  assert.equal(owner.mcp.resultError, false);
  assert.equal(owner.mcp.serverExitCode, 0); assert.equal(owner.mcp.serverExitSignal, null);
  const guard = owner.guard;
  assert.equal(guard?.completed, true); assert.equal(guard.childExitCode, 0);
  for (const field of ['stdoutEnded', 'stderrEnded', 'copyThreadsStopped']) assert.equal(guard[field], true);
  assert.deepEqual(guard.errors, []); assert.equal(guard.stoppedByGuard, null);
  assert.equal(guard.jobActiveProcesses, 0, 'Outer job retained descendants');
  assert.equal(guard.forcedCleanup, false, 'Forced cleanup cannot qualify');
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
    assert.equal(receipt.request.node, pilot.node);
    assert.equal(receipt.request.launcherSha256, owner.launcherSha256);
    assert.equal(receipt.currentLauncherSha256, owner.launcherSha256);
    for (const field of ['sourceHead', 'profileSha256', 'harnessSha256']) assert.equal(receipt.request[field], pilot[field]);
  }
  if (pilot.platform === 'linux') {
    assert.equal(owner.linux?.reason, 'command completed'); assert.equal(owner.linux.childExitCode, 0);
    assert.deepEqual(owner.linux.remainingWorkloadMembers, []);
    assert.deepEqual(owner.linux.beforeCleanupMembers, []);
    assert.deepEqual(owner.linux.cleanupErrors, []);
    assert.equal(owner.linux.forcedCleanup, false);
    assert.match(owner.linux.workloadCgroupEvents, /(?:^|\n)populated 0(?:\n|$)/);
    assert.equal(owner.linux.aggregateCgroup, supervisor.envelope.path);
    assert.equal(owner.linux.workloadCgroup, supervisor.envelope.workloadPath);
    assert.equal(supervisor.envelope.guardianIncluded, true);
    const mirror = owner.linux.datasetMirror;
    assert.equal(mirror?.complete, true); assert.equal(mirror.version, 'ext4-receipt-mirror-v1');
    assert.match(mirror.phase, /^[a-z0-9][a-z0-9-]{0,70}$/);
    assert.equal(mirror.token, owner.linux.token);
    assert.deepEqual(guard.datasetMirror, mirror, 'Outer guard did not verify the same receipt mirror');
    const filesystem = mirror.datasetFilesystem;
    assert.equal(filesystem.path, '/opt/flujo569/qualification/' + mirror.phase + '/output');
    assert.equal(filesystem.realPath, filesystem.path); assert.equal(filesystem.filesystemMagic, '0xef53');
    assert.equal(filesystem.filesystem, 'ext4');
    assert(Number.isSafeInteger(filesystem.device) && filesystem.device >= 0);
    assert(Number.isSafeInteger(filesystem.inode) && filesystem.inode > 0);
    assert.deepEqual(supervisor.datasetFilesystem, filesystem);
    assert.deepEqual(pilot.datasetFilesystem, filesystem);
    const names = ['runtime-receipt.json', 'supervisor-receipt.json', 'runtime-settled.json', 'provider-settled.json'];
    assert.deepEqual(Object.keys(mirror.files).sort(), names.sort());
    for (const [name, record] of Object.entries(mirror.files)) {
      assert.equal(record.sourcePath, filesystem.path + '/' + name);
      assert(Number.isSafeInteger(record.bytes) && record.bytes > 0 && record.bytes <= 1024 ** 2);
      assert.match(record.sha256, /^[a-f0-9]{64}$/);
    }
    assert.equal(supervisor.guestDiskAdmissions?.length, 2);
    for (const admission of supervisor.guestDiskAdmissions) {
      assert.deepEqual(admission.filesystem, filesystem);
      assert.equal(admission.requiredFreeBytes, 22 * 1024 ** 3);
      assert(admission.freeBytes >= admission.requiredFreeBytes);
    }
  } else {
    assert.equal(supervisor.processes?.windowsJob?.activeProcessesBeforeCleanup, 0);
    assert.equal(supervisor.processes.windowsJob.forcedCleanup, false);
    assertWindowsConsoleProof(guard, supervisor, false);
  }
}
function assertWindowsConsoleProof(guard, supervisor, equipment) {
  const proof = guard.windowsConsole, limit = 128 * 1024 ** 2;
  assert.equal(proof?.version, 'owned-console-final-v1'); assert.equal(proof.completed, true);
  assert.equal(proof.outerJobEmpty, true); assert.deepEqual(proof.rawErrors, []); assert.equal(proof.reserveLimitBytes, limit);
  const { token, ...controller } = proof.controller;
  assert(typeof token === 'string' && token.length > 0); assert.deepEqual(controller, supervisor.windowsConsole);
  assert.deepEqual(proof.identity, controller.identity);
  const tools = proof.windowsNativeTools;
  assert.deepEqual(tools, guard.windowsNativeTools); assert.deepEqual(tools, supervisor.windowsNativeTools);
  assert.deepEqual(tools, controller.windowsNativeTools);
  assert.deepEqual(Object.keys(tools).sort(), ['git','node']);
  for (const [kind,tool] of Object.entries(tools)) {
    assert.deepEqual(Object.keys(tool).sort(), ['path','sha256','version']);
    assert(typeof tool.path === 'string' && tool.path.length <= 1024 && path.win32.isAbsolute(tool.path));
    assert.equal(path.win32.basename(tool.path).toLowerCase(),kind+'.exe');
    assert(typeof tool.version === 'string' && tool.version.length > 0 && tool.version.length <= 64);
    assert.match(tool.sha256,/^[a-f0-9]{64}$/);
  }
  assert.notEqual(tools.git.path,tools.node.path);
  const identity = proof.identity, controllerPid = identity.controller.pid, hostPid = identity.host.pid;
  assert.equal(controllerPid, guard.ownedProcessId); assert.notEqual(controllerPid, hostPid);
  assert.equal(identity.version, 'owned-controller-console-v1'); assert.equal(identity.host.parentPid, controllerPid);
  for (const value of [identity.host, identity.controller]) assert.match(value.creationFiletime, /^[1-9][0-9]+$/);
  assert(BigInt(identity.host.creationFiletime) >= BigInt(identity.controller.creationFiletime));
  assert.equal(identity.host.affinity, identity.controller.affinity);
  assert.deepEqual(identity.initialConsole.clients, [controllerPid]); assert.equal(identity.initialConsole.visible, false);
  assert.equal(identity.initialConsole.hostCorroboration.pid, hostPid);
  assert.deepEqual(controller.admission.identity, identity); assert.equal(controller.admission.admitted, true);
  const roles = controller.roles, children = controller.children, held = proof.heldProcesses;
  assert.equal(roles.runtime, supervisor.bootstrap.pid);
  assert(Number.isSafeInteger(roles[equipment ? 'equipment-peer' : 'provider']));
  assert(!Object.hasOwn(roles, equipment ? 'provider' : 'equipment-peer'));
  assert(Object.hasOwn(roles, 'metadata-1') && Object.hasOwn(roles, 'native-probe-1'));
  for (const [role, pid] of Object.entries(roles)) {
    assert(/^(runtime|provider|equipment-peer|metadata-[1-9][0-9]?|native-probe-[1-3])$/.test(role));
    if (role.startsWith('metadata-')) assert(Number(role.slice(9)) <= 24);
    assert(Number.isSafeInteger(pid) && pid > 0 && pid !== controllerPid && pid !== hostPid);
  }
  assert.equal(Object.keys(roles).length, new Set(Object.values(roles)).size);
  assert.deepEqual(Object.entries(roles).filter(([role]) => role.startsWith('native-probe-')).sort(),
    supervisor.bootstrap.settlement.probes.map(probe => ['native-probe-' + probe.attempt, probe.pid]).sort());
  assert.deepEqual(Object.keys(children).sort(), Object.values(roles).map(String).sort());
  assert.deepEqual([...controller.publiclyAttestedPids].sort((a,b)=>a-b), Object.entries(roles).filter(([role])=>!role.startsWith('metadata-')).map(([,pid])=>pid).sort((a,b)=>a-b));
  assert.deepEqual(Object.keys(held).sort(), [String(controllerPid), String(hostPid), ...Object.keys(children)].sort());
  assert.deepEqual(proof.childAdmissions, controller.childAdmissions);
  assert.deepEqual(Object.keys(proof.childAdmissions).sort(), Object.keys(roles).filter(role => !role.startsWith('native-probe-')).sort());
  const sequences = [];
  for (const [role, admission] of Object.entries(proof.childAdmissions)) {
    assert.equal(admission.token, token); assert.equal(admission.role, role); assert.equal(admission.admitted, true);
    assert.equal(admission.stage, 'assigned-before-resume'); assert.deepEqual(admission.identity, held[roles[role]].identity);
    assert.equal(admission.consoleMode, role.startsWith('metadata-') ? 'detached-metadata' : 'inherited');
    assert.equal(admission.creationFlags, role.startsWith('metadata-') ? 12 : 4);
    sequences.push(admission.sequence);
  }
  assert.deepEqual(sequences.sort((a,b)=>a-b), sequences.map((_, index)=>index + 1));
  const metadataRoles = Object.keys(roles).filter(role=>role.startsWith('metadata-')).sort();
  assert.deepEqual(proof.metadataPermits, controller.metadataPermits); assert.deepEqual(proof.metadataSettlements, controller.metadataSettlements);
  assert.deepEqual(Object.keys(proof.metadataPermits).sort(), metadataRoles); assert.deepEqual(Object.keys(proof.metadataSettlements).sort(), metadataRoles);
  for (const role of metadataRoles) {
    const permit=proof.metadataPermits[role], settled=proof.metadataSettlements[role], command=permit.command;
    assert.equal(permit.token,token); assert.equal(permit.role,role); assert.equal(permit.sequence,Number(role.slice(9))); assert.equal(permit.admitted,true);
    assert(['git-version','git-head','git-clean','node-version','profile','dependencies','plan','source','launch'].includes(command.operation));
    assert.match(command.commandSha256,/^[a-f0-9]{64}$/); assert.match(command.tool.sha256,/^[a-f0-9]{64}$/);
    const git = command.operation.startsWith('git-');
    const expected = tools[git ? 'git' : 'node'];
    assert.deepEqual({path:command.tool.path,version:command.tool.version,sha256:command.tool.sha256},expected);
    assert(Number.isSafeInteger(command.tool.bytes) && command.tool.bytes > 0 && command.tool.bytes <= 128 * 1024 ** 2);
    assert.equal(command.tool.path.toLowerCase(),held[roles[role]].identity.image.toLowerCase());
    assert.equal(settled.token,token); assert.equal(settled.role,role); assert.equal(settled.sequence,permit.sequence); assert.equal(settled.pid,roles[role]);
    assert.equal(settled.commandSha256,command.commandSha256); assert.equal(settled.completed,true);
    assert.equal(settled.exitCode,0); assert.equal(settled.stdoutEnded,true); assert.equal(settled.stderrEnded,true);
    assert.equal(settled.innerAfter.totalProcesses,permit.innerBefore.totalProcesses+1);
    assert.equal(settled.outerAfter.totalProcesses,permit.outerBefore.totalProcesses+1);
    for (const counts of [permit.innerBefore, permit.outerBefore, settled.innerAfter, settled.outerAfter]) {
      assert(Number.isSafeInteger(counts.totalProcesses) && counts.totalProcesses >= 0 && counts.totalProcesses <= 32);
      assert.equal(counts.terminatedProcesses,0);
    }
    assert.equal(settled.finalHeldPeakRss,held[roles[role]].final.memory.peakRss);
  }
  for (const [counts,total] of [[controller.innerLifetimeCounts,Object.keys(children).length],[proof.outerLifetimeCounts,Object.keys(held).length]]) {
    assert.equal(counts.totalProcesses,total); assert.equal(counts.activeProcesses,0); assert.equal(counts.terminatedProcesses,0);
  }
  assert.equal(guard.jobTotalProcesses,proof.outerLifetimeCounts.totalProcesses);
  assert.deepEqual(held[controllerPid].identity, identity.controller); assert.deepEqual(held[hostPid].identity, identity.host);
  for (const [pid, record] of Object.entries(held)) {
    assert.equal(record.identity.pid, Number(pid));
    assert.equal(record.final?.signaled, true); assert.equal(record.final.exitCode, 0);
    assert.equal(record.final.freshJobAbsent, true); assert.equal(record.final.heldHandle, true);
    assert(Number.isSafeInteger(record.final.memory.peakRss) && record.final.memory.peakRss > 0);
    assert(Number.isSafeInteger(record.maximumObservedPeakRss) && record.final.memory.peakRss >= record.maximumObservedPeakRss);
    if (children[pid]) assert.deepEqual(children[pid].identity, record.identity);
  }
  const peak = pid => held[pid].final.memory.peakRss;
  const reserve = peak(controllerPid) + peak(hostPid);
  const control = reserve;
  assert.equal(proof.finalReservePeakRss, reserve); assert.equal(proof.finalControlPeakUpperBound, control);
  assert(control <= limit && controller.maximumControlPeakRss > 0 && controller.maximumControlPeakRss <= control);
  assert(peak(roles.runtime) <= 1024 ** 3); assert(peak(roles[equipment ? 'equipment-peer' : 'provider']) <= 384 * 1024 ** 2);
}
module.exports = { assertOwnership, assertWindowsConsoleProof };
