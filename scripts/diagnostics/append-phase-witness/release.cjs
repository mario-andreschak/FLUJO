'use strict';
// Separate post-controller process. This audit never signals or removes files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const demand = (condition, message) => { if (!condition) throw new Error(message); };
function birth(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), ppid: Number(fields[1]), pgrp: Number(fields[2]), state: fields[0], startTicks: fields[19] };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
const parent = fs.realpathSync(process.argv[2]);
demand(process.platform === 'linux' && process.arch === 'x64' && process.version === 'v22.23.3' && process.versions.uv === '1.51.0' && !process.env.NODE_OPTIONS && process.execArgv.length === 0, 'Exact separate Linux default-heap runtime required');
demand(sha(fs.readFileSync(process.execPath)) === 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48', 'Official executable bytes mismatch');
const candidates = fs.readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^append-phase-(100|250)-[0-9]+-[a-f0-9-]{36}$/.test(entry.name) && fs.existsSync(path.join(parent, entry.name, 'receipt.json')));
demand(candidates.length <= 1 && fs.existsSync(path.join(parent, 'install.receipt.json')), 'One assigned installation receipt and at most one witness receipt required');
const install = JSON.parse(fs.readFileSync(path.join(parent, 'install.receipt.json')));
const witnessEntered = candidates.length === 1;
const output = witnessEntered ? fs.realpathSync(path.join(parent, candidates[0].name)) : parent;
demand(!witnessEntered || output === path.join(parent, candidates[0].name), 'Canonical owned output required');
const receiptBytes = fs.readFileSync(path.join(output, witnessEntered ? 'receipt.json' : 'install.receipt.json'));
const receipt = JSON.parse(receiptBytes);
const assignedBytes = fs.readFileSync(path.join(parent, 'grant.effective.json'));
const assigned = JSON.parse(assignedBytes);
demand(receipt.assignmentSha256 === sha(assignedBytes) && receipt.head === assigned.head && receipt.tree === assigned.tree && receipt.count === assigned.count, 'Exact assigned controller evidence required');
const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
demand(install.assignmentSha256 === sha(assignedBytes) && install.bootId === bootId && (!witnessEntered || receipt.runtime.bootId === bootId), 'Release must observe exact assignments on the same boot instance');
demand(receipt.controller?.pid && receipt.controller.startTicks && receipt.controller.pid !== process.pid, 'Distinct controller birth identity required');
const stages = [];
let missingOutcome = false;
for (const [directory, names] of [[parent, ['install']], ...(witnessEntered ? [[output, ['dependency-guard', 'witness']]] : [])]) {
  for (const name of names) {
    const outcome = path.join(directory, name + '.outcome.json');
    if (fs.existsSync(outcome)) stages.push(JSON.parse(fs.readFileSync(outcome)));
    else if (fs.existsSync(path.join(directory, name + '.stdout.log')) || fs.existsSync(path.join(directory, name + '.stderr.log'))) missingOutcome = true;
  }
}
// Stage files are authoritative even if stage() refused before its result could
// be added to a controller receipt. Never lose a survivor on that throw path.
const records = [receipt.controller, install.controller, ...stages.flatMap(stage => stage.observedProcesses ?? [])];
demand(records.every(item => item.pid && /^[0-9]+$/.test(item.startTicks)), 'Every known process requires its birth marker');
const checks = records.map(item => { const current = birth(item.pid); return { recorded: item, current, sameBirthPresent: current?.startTicks === item.startTicks }; });
const knownProcessBirthsAbsent = checks.every(item => !item.sameBirthPresent);
const stagesResolved = !missingOutcome && stages.every(stage => stage.leader && stage.survivors.length === 0 && stage.unresolvedGroupMembers.length === 0);
const git = args => execFileSync('git', ['-C', assigned.checkout, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();
const sourceClean = receipt.sourceRestored === true && install.sourceRestored === true && git(['rev-parse', 'HEAD']) === assigned.head && git(['rev-parse', 'HEAD^{tree}']) === assigned.tree && git(['status', '--porcelain=v1', '--untracked-files=all']) === '' && [...receipt.sourceBefore, ...install.sourceBefore].every(pin => sha(fs.readFileSync(path.join(assigned.checkout, pin.file))) === pin.sha256);
const manifests = [[parent, 'install.manifest.json'], ...(witnessEntered ? [[output, 'manifest.json']] : [])];
const outputMembersMatch = manifests.every(([directory, file]) => JSON.parse(fs.readFileSync(path.join(directory, file))).members.every(member => path.basename(member.file) === member.file && sha(fs.readFileSync(path.join(directory, member.file))) === member.sha256));
const releasePass = knownProcessBirthsAbsent && stagesResolved && sourceClean && outputMembersMatch;
const result = { schemaVersion: 1, state: releasePass ? (witnessEntered ? 'RELEASED' : 'RELEASED_INSTALL_ONLY_NO_WITNESS') : 'RELEASE_REFUSED', auditedAtUtc: new Date().toISOString(), witnessEntered, receiptSha256: sha(receiptBytes), effectiveAssignmentSha256: sha(assignedBytes), packetManifestSha256: receipt.packetManifestSha256, bootId, releasedBy: birth(process.pid), controllerAlreadyExited: !checks[0].sameBirthPresent, knownProcessBirthsAbsent, stagesResolved, missingOutcome, sourceClean, outputMembersMatch, processChecks: checks, qualificationScope: 'observed process births/source release only; no performance, endurance, installed or adoption acceptance' };
const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
fs.writeFileSync(path.join(output, witnessEntered ? 'release.json' : 'release.install-only.json'), bytes, { flag: 'wx', mode: 0o600 });
// Flat predecessor copies make a reviewed100 artifact directly consumable by250.
if (witnessEntered) {
  fs.copyFileSync(path.join(output, 'receipt.json'), path.join(parent, 'receipt.json'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(parent, 'release.json'), bytes, { flag: 'wx', mode: 0o600 });
}
process.stdout.write(JSON.stringify({ state: result.state, receiptSha256: sha(receiptBytes), releaseSha256: sha(bytes), output }) + '\n');
demand(releasePass, 'Remaining birth/source/manifest issue; assignment must remain held');
