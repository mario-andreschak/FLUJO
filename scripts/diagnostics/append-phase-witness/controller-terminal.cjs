'use strict';
// Source-only preparation. A controller cannot certify its own process exit.
// Candidate files become usable only with a separate, timely original-birth
// absence observation made AFTER all candidate files have been read and hashed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const demand = (condition, message) => { if (!condition) throw new Error(message); };
const bootMilliseconds = () => {
  const value = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
  demand(Number.isFinite(value) && value > 0, 'Shared boot monotonic clock required');
  return value;
};
function entryClock() {
  const mono = performance.now();
  const boot = bootMilliseconds();
  const utc = Date.now();
  return { utc, mono, boot, bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}
function createDeadline(expiresAtUtc, anchor) {
  const grantStopUtc = Date.parse(expiresAtUtc);
  // The earlier mono/boot readings and later UTC anchor shorten the allowance.
  // An additional20ms covers the shared boot clock's centisecond quantization.
  const record = { schemaVersion: 4, anchor, grantStopUtc, grantStopMono: anchor.mono + grantStopUtc - anchor.utc, grantStopBootMs: anchor.boot + grantStopUtc - anchor.utc - 20 };
  demand(validDeadline(record, expiresAtUtc), 'Invalid absolute controller deadline');
  const remaining = () => {
    const boot = bootMilliseconds();
    return Math.min(record.grantStopUtc - Date.now(), record.grantStopMono - performance.now(), record.grantStopBootMs - boot);
  };
  const check = label => demand(remaining() > 0, 'Controller deadline crossed: ' + label);
  const bounded = (label, operation) => { check('before ' + label); const result = operation(); check('after ' + label); return result; };
  const git = (root, args) => bounded('git ' + args[0], () => {
    const timeout = Math.min(10_000, Math.floor(remaining()));
    demand(timeout >= 1, 'No remaining grant budget for Git');
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 }).trim();
  });
  const stamp = label => bounded(label, () => ({ utc: Date.now(), mono: performance.now(), boot: bootMilliseconds() }));
  check('controller admission');
  return { record, remaining, check, bounded, git, stamp };
}
function validDeadline(value, expiresAtUtc) {
  const anchor = value?.anchor;
  return value?.schemaVersion === 4 && typeof anchor?.bootId === 'string' && anchor.bootId.length > 0 && [anchor.utc, anchor.mono, anchor.boot, value.grantStopUtc, value.grantStopMono, value.grantStopBootMs].every(Number.isFinite) && value.grantStopUtc === Date.parse(expiresAtUtc) && value.grantStopMono === anchor.mono + value.grantStopUtc - anchor.utc && value.grantStopBootMs === anchor.boot + value.grantStopUtc - anchor.utc - 20 && value.grantStopUtc > anchor.utc;
}
const beforeStop = (stamp, deadline) => !!stamp && [stamp.utc, stamp.mono, stamp.boot].every(Number.isFinite) && stamp.utc >= deadline.anchor.utc && stamp.mono >= deadline.anchor.mono && stamp.boot >= deadline.anchor.boot && stamp.utc < deadline.grantStopUtc && stamp.mono < deadline.grantStopMono && stamp.boot < deadline.grantStopBootMs;
function preservePartial(directory, prefix, receipt, error) {
  // Deliberately unqualified best-effort raw evidence, even after the deadline.
  // It cannot replace a candidate or serve as terminal proof.
  const partial = { schemaVersion: 4, state: 'CONTROLLER_FINALIZATION_PARTIAL_OR_LATE_RELEASE_HELD', recordedAtUtc: new Date().toISOString(), receipt, error: { name: error.name, message: error.message, stack: error.stack } };
  try { fs.writeFileSync(path.join(directory, prefix + 'finalization.partial.json'), JSON.stringify(partial, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (writeError) { process.stderr.write('Partial finalization persistence failed: ' + writeError.message + '\n'); }
}
function persistCandidate(directory, prefix, receipt, deadline) {
  const receiptFile = prefix + 'receipt.json';
  const manifestFile = prefix + 'manifest.json';
  const candidateFile = prefix + 'controller.finalization.json';
  receipt.schemaVersion = 4;
  receipt.controllerDeadline = deadline.record;
  receipt.auditsCompletedAt = deadline.stamp('post-audit stamp');
  receipt.endedAtUtc = new Date(receipt.auditsCompletedAt.utc).toISOString();
  const receiptBytes = deadline.bounded('receipt serialization', () => Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  deadline.bounded('receipt persistence', () => fs.writeFileSync(path.join(directory, receiptFile), receiptBytes, { flag: 'wx', mode: 0o600 }));
  const receiptPersistedAt = deadline.stamp('receipt persisted stamp');
  const members = deadline.bounded('manifest enumeration', () => fs.readdirSync(directory, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => deadline.bounded('manifest member ' + entry.name, () => {
    const bytes = fs.readFileSync(path.join(directory, entry.name));
    return { file: entry.name, bytes: bytes.length, sha256: sha(bytes) };
  }));
  const manifestBytes = deadline.bounded('manifest serialization', () => Buffer.from(JSON.stringify({ schemaVersion: 4, members, excludesPreservedSyntheticSubtree: true, finalizationCandidateExcluded: candidateFile }, null, 2) + '\n'));
  deadline.bounded('manifest persistence', () => fs.writeFileSync(path.join(directory, manifestFile), manifestBytes, { flag: 'wx', mode: 0o600 }));
  const manifestPersistedAt = deadline.stamp('manifest persisted stamp');
  const candidate = { schemaVersion: 4, state: 'FINALIZATION_CANDIDATE_REQUIRES_INDEPENDENT_ORIGINAL_CONTROLLER_EXIT', controller: receipt.controller, bootId: deadline.record.anchor.bootId, controllerDeadline: deadline.record, controllerIntentSha256: receipt.controllerIntentSha256, assignmentSha256: receipt.assignmentSha256, packetManifestSha256: receipt.packetManifestSha256, head: receipt.head, tree: receipt.tree, count: receipt.count, receiptFile, receiptSha256: sha(receiptBytes), manifestFile, manifestSha256: sha(manifestBytes), receiptPersistedAt, manifestPersistedAt, candidatePreparedAt: deadline.stamp('candidate prepared stamp'), candidateReceiptState: receipt.state };
  const candidateBytes = deadline.bounded('candidate serialization', () => Buffer.from(JSON.stringify(candidate, null, 2) + '\n'));
  deadline.bounded('candidate persistence', () => fs.writeFileSync(path.join(directory, candidateFile), candidateBytes, { flag: 'wx', mode: 0o600 }));
  // If the last write returns late, even a complete-looking candidate is partial.
  // The independent audit also requires absence AND candidate reads before expiry.
  deadline.check('terminal handoff after all persistence');
  return candidate;
}
function assertReleasedPredecessor(earlierBytes, releasedBytes, assigned) {
  const earlier = JSON.parse(earlierBytes); const released = JSON.parse(releasedBytes);
  demand(earlier.schemaVersion === 4 && earlier.count === 100 && earlier.head === assigned.head && earlier.tree === assigned.tree && earlier.packetManifestSha256 === assigned.packetManifestSha256 && earlier.sourceRestored === true && earlier.state === 'SHORT_WITNESS_COMPLETED_PENDING_INDEPENDENT_TERMINAL_PROOF' && earlier.stages?.length === 2 && earlier.stages.every(item => item.natural === true && item.exit?.code === 0), 'Same-source/same-packet100 natural candidate required');
  demand(released.schemaVersion === 4 && released.state === 'RELEASED' && released.knownProcessBirthsAbsent === true && released.controllerAlreadyExited === true && released.sourceClean === true && released.outputMembersMatch === true && released.releasedBy?.pid !== earlier.controller.pid && released.receiptSha256 === sha(earlierBytes) && released.effectiveAssignmentSha256 === earlier.assignmentSha256 && released.packetManifestSha256 === earlier.packetManifestSha256, 'Independently released100 required');
  const proofs = released.controllerTerminalProofs;
  demand(Array.isArray(proofs) && proofs.length === 2 && proofs.filter(item => item.kind === 'install').length === 1 && proofs.filter(item => item.kind === 'witness').length === 1, 'Both original controllers require terminal proof');
  for (const proof of proofs) {
    const candidate = proof.candidate;
    const deadline = candidate?.controllerDeadline;
    demand(candidate?.schemaVersion === 4 && candidate.state === 'FINALIZATION_CANDIDATE_REQUIRES_INDEPENDENT_ORIGINAL_CONTROLLER_EXIT' && validDeadline(deadline, new Date(deadline?.grantStopUtc).toISOString()) && candidate.bootId === released.bootId && deadline.anchor.bootId === released.bootId && sha(Buffer.from(JSON.stringify(candidate, null, 2) + '\n')) === proof.candidateSha256 && /^[a-f0-9]{64}$/.test(candidate.manifestSha256 ?? ''), 'Original finalization/deadline proof required');
    demand(candidate.assignmentSha256 === earlier.assignmentSha256 && candidate.head === earlier.head && candidate.tree === earlier.tree && candidate.count === 100 && candidate.packetManifestSha256 === earlier.packetManifestSha256, 'Terminal source/packet/assignment mismatch');
    demand(Number.isSafeInteger(candidate.controller?.pid) && candidate.controller.pid > 0 && /^[0-9]+$/.test(candidate.controller.startTicks ?? '') && proof.originalBirthAbsent === true && proof.observedBy?.pid === released.releasedBy.pid && proof.observedBy.startTicks === released.releasedBy.startTicks && proof.observedBy.pid !== candidate.controller.pid && proof.observedAtBootId === released.bootId && [candidate.receiptPersistedAt, candidate.manifestPersistedAt, candidate.candidatePreparedAt].every(stamp => beforeStop(stamp, deadline)) && candidate.receiptPersistedAt.utc <= candidate.manifestPersistedAt.utc && candidate.manifestPersistedAt.utc <= candidate.candidatePreparedAt.utc && candidate.receiptPersistedAt.mono <= candidate.manifestPersistedAt.mono && candidate.manifestPersistedAt.mono <= candidate.candidatePreparedAt.mono && Number.isFinite(proof.observedAbsentAtUtc) && Number.isFinite(proof.observedAbsentAtBootMs) && proof.observedAbsentAtUtc >= candidate.candidatePreparedAt.utc && proof.observedAbsentAtBootMs >= candidate.candidatePreparedAt.boot && proof.observedAbsentAtUtc < deadline.grantStopUtc && proof.observedAbsentAtBootMs < deadline.grantStopBootMs, 'Late, incomplete or self-observed controller terminal proof');
    const expectedState = proof.kind === 'witness' ? 'SHORT_WITNESS_COMPLETED_PENDING_INDEPENDENT_TERMINAL_PROOF' : 'INSTALL_COMPLETED_PENDING_INDEPENDENT_TERMINAL_PROOF';
    demand(candidate.candidateReceiptState === expectedState && proof.nativeControllerStepOutcome === 'success', 'Prior100 controller did not complete naturally');
    if (proof.kind === 'witness') demand(candidate.receiptSha256 === sha(earlierBytes) && candidate.controllerIntentSha256 === earlier.controllerIntentSha256 && candidate.controller.pid === earlier.controller.pid && candidate.controller.startTicks === earlier.controller.startTicks && JSON.stringify(deadline) === JSON.stringify(earlier.controllerDeadline), 'Prior100 witness terminal proof does not bind its receipt');
  }
  return { earlier, released };
}
module.exports = { entryClock, createDeadline, validDeadline, beforeStop, bootMilliseconds, persistCandidate, preservePartial, assertReleasedPredecessor };
