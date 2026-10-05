'use strict';
// Separate post-controller source audit. Missing original evidence always holds
// release; this helper never signals a PID or repairs/reconstructs missing proof.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { entryClock, createDeadline, validDeadline, beforeStop, bootMilliseconds } = require('./controller-terminal.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const demand = (condition, message) => { if (!condition) throw new Error(message); };
function birth(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), ppid: Number(fields[1]), pgrp: Number(fields[2]), state: fields[0], startTicks: fields[19] };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
demand(process.platform === 'linux' && process.arch === 'x64' && process.version === 'v22.23.3' && process.versions.uv === '1.51.0' && !process.env.NODE_OPTIONS && process.execArgv.length === 0, 'Exact separate Linux default-heap runtime required');
const enteredClock = entryClock();
demand(sha(fs.readFileSync(process.execPath)) === 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48', 'Official executable bytes mismatch');
const parent = fs.realpathSync(process.argv[2]);
const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const errors = [];
const records = [];
const stageEvidence = [];
const controllerTerminalProofs = [];
const evidence = file => {
  try { const bytes = fs.readFileSync(file); return { file, bytes, sha256: sha(bytes), value: JSON.parse(bytes) }; }
  catch (error) { errors.push({ file, reason: 'MISSING_OR_INVALID_ORIGINAL_EVIDENCE', code: error.code, message: error.message }); return null; }
};
const check = (condition, reason, file) => { if (!condition) errors.push({ reason, file }); return !!condition; };
const validBirth = item => Number.isSafeInteger(item?.pid) && item.pid > 0 && /^[0-9]+$/.test(item.startTicks ?? '');
const sameBirth = (left, right) => validBirth(left) && validBirth(right) && left.pid === right.pid && left.startTicks === right.startTicks;
const remember = (item, file) => { if (check(validBirth(item), 'MISSING_ORIGINAL_PROCESS_BIRTH', file)) records.push(item); };
const assignedEvidence = evidence(path.join(parent, 'grant.effective.json'));
const assigned = assignedEvidence?.value;
const binding = evidence(path.join(parent, 'binding.json'))?.value;
check(assigned && binding?.effectiveAssignmentSha256 === assignedEvidence.sha256, 'ASSIGNMENT_BINDING_MISMATCH', parent);
let auditDeadline;
try { auditDeadline = createDeadline(assigned?.expiresAtUtc, enteredClock); }
catch (error) { errors.push({ reason: 'RELEASE_AUDIT_ENTERED_AFTER_OR_WITHOUT_ASSIGNED_DEADLINE', message: error.message }); }
function controller(directory, intentName, receiptName, kind) {
  const intent = evidence(path.join(directory, intentName));
  const receipt = evidence(path.join(directory, receiptName));
  const prefix = kind === 'install' ? 'install.' : '';
  const candidate = evidence(path.join(directory, prefix + 'controller.finalization.json'));
  const manifest = evidence(path.join(directory, prefix + 'manifest.json'));
  if (intent) remember(intent.value.controller, intent.file);
  if (receipt) remember(receipt.value.controller, receipt.file);
  if (intent && receipt) {
    check(intent.value.schemaVersion === 4 && receipt.value.schemaVersion === 4 && receipt.value.controllerIntentSha256 === intent.sha256 && sameBirth(intent.value.controller, receipt.value.controller), 'ORIGINAL_CONTROLLER_INTENT_RECEIPT_MISMATCH', directory);
    check(intent.value.bootId === bootId && (kind === 'witness' ? receipt.value.runtime?.bootId : receipt.value.bootId) === bootId, 'CONTROLLER_BOOT_MISMATCH', directory);
    for (const original of [intent.value, receipt.value]) check(original.assignmentSha256 === assignedEvidence?.sha256 && original.head === assigned?.head && original.tree === assigned?.tree && original.count === assigned?.count && original.packetManifestSha256 === assigned?.packetManifestSha256, 'CONTROLLER_SOURCE_ASSIGNMENT_MISMATCH', directory);
  }
  check(!fs.existsSync(path.join(directory, prefix + 'finalization.partial.json')), 'CONTROLLER_RECORDED_PARTIAL_OR_LATE_FINALIZATION', directory);
  if (intent && receipt && candidate && manifest) {
    const original = candidate.value;
    const deadline = original.controllerDeadline;
    const nativeControllerStepOutcome = process.env[kind === 'install' ? 'INSTALL_CONTROLLER_STEP_OUTCOME' : 'WITNESS_CONTROLLER_STEP_OUTCOME'];
    let complete = check(original.schemaVersion === 4 && original.state === 'FINALIZATION_CANDIDATE_REQUIRES_INDEPENDENT_ORIGINAL_CONTROLLER_EXIT' && original.receiptFile === receiptName && original.manifestFile === prefix + 'manifest.json' && original.receiptSha256 === receipt.sha256 && original.manifestSha256 === manifest.sha256 && original.controllerIntentSha256 === intent.sha256 && original.candidateReceiptState === receipt.value.state && sameBirth(original.controller, intent.value.controller), 'ORIGINAL_FINALIZATION_HASH_BIRTH_OR_STATE_MISMATCH', directory);
    complete = check(validDeadline(deadline, assigned?.expiresAtUtc) && JSON.stringify(deadline) === JSON.stringify(intent.value.controllerDeadline) && JSON.stringify(deadline) === JSON.stringify(receipt.value.controllerDeadline) && original.bootId === bootId && deadline?.anchor.bootId === bootId && [receipt.value.auditsCompletedAt, original.receiptPersistedAt, original.manifestPersistedAt, original.candidatePreparedAt].every(stamp => beforeStop(stamp, deadline)), 'CONTROLLER_FINALIZATION_LATE_OR_UNBOUND_DEADLINE', directory) && complete;
    complete = check(original.assignmentSha256 === assignedEvidence?.sha256 && original.head === assigned?.head && original.tree === assigned?.tree && original.count === assigned?.count && original.packetManifestSha256 === assigned?.packetManifestSha256, 'FINALIZATION_SOURCE_ASSIGNMENT_MISMATCH', directory) && complete;
    const naturalCandidate = ['INSTALL_COMPLETED_PENDING_INDEPENDENT_TERMINAL_PROOF', 'SHORT_WITNESS_COMPLETED_PENDING_INDEPENDENT_TERMINAL_PROOF'].includes(original.candidateReceiptState);
    complete = check(['success', 'failure'].includes(nativeControllerStepOutcome) && (!naturalCandidate || nativeControllerStepOutcome === 'success'), 'NATIVE_CONTROLLER_STEP_TERMINAL_OUTCOME_MISSING_OR_NOT_SUCCESSFUL', directory) && complete;
    // All original terminal files were read and hashed above. Their completed
    // persistence and controller exit must precede this independent observation.
    // A pre-write timestamp in a late/hung candidate can never satisfy this.
    const current = validBirth(original.controller) ? birth(original.controller.pid) : null;
    const observedAbsentAtBootMs = bootMilliseconds();
    const observedAbsentAtUtc = Date.now();
    const originalBirthAbsent = validBirth(original.controller) && !sameBirth(current, original.controller) && original.controller.pid !== process.pid;
    complete = check(originalBirthAbsent && observedAbsentAtUtc >= original.candidatePreparedAt?.utc && observedAbsentAtBootMs >= original.candidatePreparedAt?.boot && observedAbsentAtUtc < deadline?.grantStopUtc && observedAbsentAtBootMs < deadline?.grantStopBootMs, 'ORIGINAL_CONTROLLER_TERMINAL_ABSENCE_MISSING_OR_AFTER_EXPIRY', directory) && complete;
    if (complete) controllerTerminalProofs.push({ kind, directory, candidate: original, candidateSha256: candidate.sha256, nativeControllerStepOutcome, originalBirthAbsent, observedAbsentAtUtc, observedAbsentAtBootMs, observedAtBootId: bootId, observedBy: birth(process.pid) });
  }
  return { directory, intent, receipt, candidate, manifest, kind };
}
function inspectStages(owner, names) {
  for (const file of fs.readdirSync(owner.directory)) {
    if (file.endsWith('.intent.json') && file !== 'controller.intent.json' && file !== 'install.controller.intent.json') check(names.some(name => file === name + '.intent.json'), 'UNEXPECTED_STAGE_INTENT', owner.directory);
  }
  const declared = owner.receipt?.value.stages ?? [];
  for (const stage of declared) check(names.includes(stage.name), 'UNEXPECTED_DECLARED_STAGE', owner.directory);
  for (const name of names) {
    const files = ['intent.json', 'birth.json', 'outcome.json', 'stdout.log', 'stderr.log'].map(suffix => path.join(owner.directory, name + '.' + suffix));
    const attempted = files.some(file => fs.existsSync(file)) || declared.some(stage => stage.name === name);
    if (!attempted) continue;
    const intent = evidence(files[0]);
    const originalBirth = evidence(files[1]);
    const outcome = evidence(files[2]);
    if (intent) remember(intent.value.controller, intent.file);
    if (originalBirth) { remember(originalBirth.value.controller, originalBirth.file); remember(originalBirth.value.leader, originalBirth.file); }
    if (outcome) for (const item of outcome.value.observedProcesses ?? []) remember(item, outcome.file);
    let complete = !!intent && !!originalBirth && !!outcome;
    if (complete) {
      complete = check(intent.value.schemaVersion === 3 && originalBirth.value.schemaVersion === 3 && outcome.value.schemaVersion === 3 && originalBirth.value.intentSha256 === intent.sha256 && outcome.value.intentSha256 === intent.sha256 && outcome.value.birthSha256 === originalBirth.sha256, 'ORIGINAL_STAGE_HASH_LINK_MISMATCH', owner.directory) && complete;
      complete = check(intent.value.name === name && originalBirth.value.name === name && outcome.value.name === name && originalBirth.value.state === 'ORIGINAL_CHILD_BIRTH_RECORDED' && sameBirth(originalBirth.value.leader, outcome.value.leader) && sameBirth(intent.value.controller, owner.intent?.value.controller) && sameBirth(originalBirth.value.controller, intent.value.controller) && sameBirth(outcome.value.controller, intent.value.controller), 'ORIGINAL_STAGE_BIRTH_OWNER_MISMATCH', owner.directory) && complete;
      complete = check(intent.value.bootId === bootId && originalBirth.value.bootId === bootId && outcome.value.bootId === bootId && outcome.value.observedProcesses?.some(item => sameBirth(item, originalBirth.value.leader)) && outcome.value.exit && outcome.value.closeObserved === true && outcome.value.logDrained === true && outcome.value.logErrors?.length === 0 && outcome.value.cleanupDeadlineReached === false && intent.value.grantStopUtc === owner.intent?.value.controllerDeadline?.grantStopUtc && Number.isFinite(intent.value.stageStopUtc) && Number.isFinite(intent.value.cleanupStopUtc) && intent.value.cleanupStopUtc <= intent.value.grantStopUtc && Date.parse(outcome.value.endedAt) < intent.value.cleanupStopUtc && outcome.value.grantStopUtc === intent.value.grantStopUtc && outcome.value.stageStopUtc === intent.value.stageStopUtc && outcome.value.cleanupStopUtc === intent.value.cleanupStopUtc && Array.isArray(outcome.value.survivors) && outcome.value.survivors.length === 0 && Array.isArray(outcome.value.unresolvedGroupMembers) && outcome.value.unresolvedGroupMembers.length === 0, 'STAGE_INCOMPLETE_CLOSE_DRAIN_DEADLINE_OR_SURVIVOR_PROOF', owner.directory) && complete;
    }
    stageEvidence.push({ directory: owner.directory, name, attempted, complete, intentSha256: intent?.sha256, birthSha256: originalBirth?.sha256, outcomeSha256: outcome?.sha256 });
  }
  const required = owner.receipt?.value.state === 'INSTALL_COMPLETED_PENDING_INDEPENDENT_TERMINAL_PROOF' ? ['install'] : owner.receipt?.value.state === 'SHORT_WITNESS_COMPLETED_PENDING_INDEPENDENT_TERMINAL_PROOF' ? ['dependency-guard', 'witness'] : [];
  for (const name of required) check(stageEvidence.some(item => item.directory === owner.directory && item.name === name && item.complete), 'REQUIRED_COMPLETED_STAGE_MISSING', owner.directory);
}
const install = controller(parent, 'install.controller.intent.json', 'install.receipt.json', 'install');
inspectStages(install, ['install']);
// Enumerate namespaces even when the controller died before receipt/fixture.
const namespaces = fs.readdirSync(parent, { withFileTypes: true }).filter(entry => /^append-phase-(100|250)-[0-9]+-[a-f0-9-]{36}$/.test(entry.name));
check(namespaces.length <= 1, 'MULTIPLE_WITNESS_NAMESPACES', parent);
const witnesses = [];
for (const entry of namespaces) {
  const directory = path.join(parent, entry.name);
  if (!check(entry.isDirectory() && fs.realpathSync(directory) === directory, 'NONCANONICAL_WITNESS_NAMESPACE', directory)) continue;
  const owner = controller(directory, 'controller.intent.json', 'receipt.json', 'witness');
  witnesses.push(owner); inspectStages(owner, ['dependency-guard', 'witness']);
}
// Successful install followed by a dead/preflight-failed witness controller
// cannot be certified as an install-only release merely because no receipt exists.
check(namespaces.length > 0 || install.receipt?.value.state !== 'INSTALL_COMPLETED_PENDING_INDEPENDENT_TERMINAL_PROOF', 'SUCCESSFUL_INSTALL_WITHOUT_COMPLETED_WITNESS_CONTROLLER_PROOF', parent);
let sourceClean = false;
let outputMembersMatch = false;
try {
  const owners = [install, ...witnesses];
  demand(auditDeadline, 'Remaining assigned deadline required for release source audit');
  const git = args => auditDeadline.git(assigned.checkout, args);
  sourceClean = owners.every(owner => owner.receipt?.value.sourceRestored === true && Array.isArray(owner.receipt.value.sourceBefore) && owner.receipt.value.sourceBefore.length === 19 && owner.receipt.value.sourceBefore.every(pin => sha(fs.readFileSync(path.join(assigned.checkout, pin.file))) === pin.sha256)) && git(['rev-parse', 'HEAD']) === assigned.head && git(['rev-parse', 'HEAD^{tree}']) === assigned.tree && git(['status', '--porcelain=v1', '--untracked-files=all']) === '';
  outputMembersMatch = owners.every(owner => {
    const manifest = owner.manifest?.value;
    return !!manifest && manifest.schemaVersion === 4 && manifest.members.some(member => member.file === (owner.kind === 'install' ? 'install.receipt.json' : 'receipt.json') && member.sha256 === owner.receipt?.sha256) && manifest.members.every(member => path.basename(member.file) === member.file && sha(fs.readFileSync(path.join(owner.directory, member.file))) === member.sha256) && sha(fs.readFileSync(owner.manifest.file)) === owner.manifest.sha256 && sha(fs.readFileSync(owner.candidate.file)) === owner.candidate.sha256;
  });
  auditDeadline.check('after release source/manifest closure');
} catch (error) { errors.push({ reason: 'SOURCE_OR_MANIFEST_AUDIT_FAILED', message: error.message }); }
check(sourceClean, 'SOURCE_CLOSURE_INCOMPLETE', parent);
check(outputMembersMatch, 'OUTPUT_MANIFEST_CLOSURE_INCOMPLETE', parent);
const processChecks = records.map(recorded => { const current = birth(recorded.pid); return { recorded, current, sameBirthPresent: current?.startTicks === recorded.startTicks }; });
const knownProcessBirthsAbsent = records.length > 0 && processChecks.every(item => !item.sameBirthPresent);
check(knownProcessBirthsAbsent, 'KNOWN_ORIGINAL_PROCESS_BIRTH_STILL_PRESENT_OR_UNPROVEN', parent);
check(records.every(item => item.pid !== process.pid), 'AUDIT_IS_NOT_SEPARATE_FROM_CONTROLLER', parent);
const witness = witnesses.length === 1 ? witnesses[0] : null;
check(controllerTerminalProofs.length === 1 + witnesses.length, 'EVERY_CONTROLLER_REQUIRES_ORIGINAL_TIMELY_TERMINAL_PROOF', parent);
try { demand(auditDeadline, 'Release deadline required'); auditDeadline.check('after source, manifest and process absence audits'); }
catch (error) { errors.push({ reason: 'RELEASE_AUDIT_FINAL_CHECK_LATE_OR_INCOMPLETE', message: error.message }); }
const complete = errors.length === 0 && stageEvidence.every(item => item.complete);
const result = { schemaVersion: 4, state: complete ? (witness ? 'RELEASED' : 'RELEASED_INSTALL_ONLY_NO_WITNESS') : 'RELEASE_REFUSED', auditedAtUtc: new Date().toISOString(), witnessEntered: namespaces.length > 0, witnessNamespaces: namespaces.map(item => item.name), receiptSha256: witness?.receipt?.sha256 ?? install.receipt?.sha256, effectiveAssignmentSha256: assignedEvidence?.sha256, packetManifestSha256: assigned?.packetManifestSha256, bootId, releasedBy: birth(process.pid), controllerAlreadyExited: complete && knownProcessBirthsAbsent, knownProcessBirthsAbsent, stagesResolved: complete, sourceClean, outputMembersMatch, controllerTerminalProofs, stageEvidence, errors, processChecks, qualificationScope: 'complete original evidence and independent controller exit observed after terminal files were read and before UTC/shared-monotonic expiry; no performance/runtime/adoption acceptance' };
const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
fs.writeFileSync(path.join(parent, 'release.audit.json'), bytes, { flag: 'wx', mode: 0o600 });
if (witness?.receipt) fs.writeFileSync(path.join(witness.directory, 'release.json'), bytes, { flag: 'wx', mode: 0o600 });
if (complete && witness) {
  fs.writeFileSync(path.join(parent, 'receipt.json'), witness.receipt.bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(parent, 'release.json'), bytes, { flag: 'wx', mode: 0o600 });
}
process.stdout.write(JSON.stringify({ state: result.state, errors: errors.length, releaseSha256: sha(bytes) }) + '\n');
demand(complete, 'Missing original controller/stage/birth/outcome evidence or closure issue; release remains held');
