'use strict';
// PREPARED ONLY. This optional hosted-route controller requires its own explicit
// installation authorization. It shares the witness birth-aware stage watchdog.
const fs = require('node:fs');
const path = require('node:path');
const { birth, stage, sha, demand } = require('./run.cjs');
const { entryClock, createDeadline, persistCandidate, preservePartial } = require('./controller-terminal.cjs');
async function main() {
  demand(process.platform === 'linux', 'Linux controller clock required');
  const enteredClock = entryClock();
  const assignedBytes = fs.readFileSync(process.argv[2]);
  const assigned = JSON.parse(assignedBytes);
  const deadline = createDeadline(assigned.expiresAtUtc, enteredClock);
  demand(process.platform === 'linux' && process.arch === 'x64' && process.version === 'v22.23.3' && process.versions.uv === '1.51.0' && !process.env.NODE_OPTIONS && !process.env.CI_SKIP_PERF && process.execArgv.length === 0, 'Exact Linux default-heap runtime required');
  demand(sha(fs.readFileSync(process.execPath)) === 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48', 'Official executable bytes mismatch');
  demand(assigned.state === 'ASSIGNED' && assigned.installAuthorized === true && assigned.authorizedByRoot === true && assigned.authorizedByQueue === true && assigned.exclusiveWindowAssigned === true && assigned.separateAppendWitnessAuthorized === true, 'Explicit exclusive hosted install assignment required');
  const output = fs.realpathSync(assigned.outputParent);
  const root = fs.realpathSync(assigned.checkout);
  const binding = JSON.parse(fs.readFileSync(path.join(output, 'binding.json')));
  demand(root === assigned.checkout && binding.effectiveAssignmentSha256 === sha(assignedBytes) && binding.head === assigned.head && binding.tree === assigned.tree, 'Exact already-bound assignment required');
  const manifestBytes = fs.readFileSync(path.join(__dirname, 'manifest.json'));
  demand(sha(manifestBytes) === assigned.packetManifestSha256, 'Reviewed packet mismatch');
  for (const member of JSON.parse(manifestBytes).members) demand(path.basename(member.file) === member.file && sha(fs.readFileSync(path.join(__dirname, member.file))) === member.sha256, 'Packet member changed: ' + member.file);
  demand(sha(fs.readFileSync(assigned.npmCli)) === assigned.npmCliSha256 && assigned.npmCliSha256 === '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7', 'Official bundled npm CLI mismatch');
  const git = args => deadline.git(root, args);
  demand(git(['rev-parse', 'HEAD']) === 'f67f215d2c698f961d28efdb50267454b4b1faf6' && git(['rev-parse', 'HEAD^{tree}']) === 'd09c5ccdd5a85d6e41061ecef683a0996d938c8e' && git(['status', '--porcelain=v1', '--untracked-files=all']) === '', 'Clean failed source required before installation');
  const sourceBefore = JSON.parse(fs.readFileSync(path.join(__dirname, 'current-source-pins.json'))).sourceComparison.pins.filter(pin => pin.role === 'traced append input').map(pin => ({ file: pin.file, gitBlob: pin.gitBlob, sha256: sha(fs.readFileSync(path.join(root, pin.file))) }));
  demand(sourceBefore.length === 19 && !fs.existsSync(path.join(root, 'node_modules')), 'Fresh19-input owned hosted target without an existing graph required');
  const receipt = { schemaVersion: 1, state: 'INSTALL_ENTERED_NO_WITNESS_YET', count: assigned.count, head: assigned.head, tree: assigned.tree, assignmentSha256: sha(assignedBytes), packetManifestSha256: sha(manifestBytes), controller: birth(process.pid), bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), sourceBefore, stages: [], enteredAtUtc: new Date().toISOString() };
  let failure;
  receipt.schemaVersion = 4;
  receipt.controllerDeadline = deadline.record;
  const controllerIntentBytes = Buffer.from(JSON.stringify({ schemaVersion: 4, state: 'INSTALL_CONTROLLER_ENTERED_BEFORE_STAGE', controller: receipt.controller, bootId: receipt.bootId, controllerDeadline: deadline.record, head: receipt.head, tree: receipt.tree, count: receipt.count, assignmentSha256: receipt.assignmentSha256, packetManifestSha256: receipt.packetManifestSha256 }, null, 2) + '\n');
  deadline.bounded('install controller intent persistence', () => fs.writeFileSync(path.join(output, 'install.controller.intent.json'), controllerIntentBytes, { flag: 'wx', mode: 0o600 }));
  receipt.controllerIntentSha256 = sha(controllerIntentBytes);
  try {
    demand(Date.parse(assigned.notBeforeUtc) <= Date.now() && deadline.remaining() > 410_000, 'At least410s assigned time remaining required before installation plus witness');
    const outcome = await stage('install', [assigned.npmCli, 'ci', '--include=dev'], 180_000, { root, output, expiresAtUtc: assigned.expiresAtUtc, controllerDeadline: deadline, environment: { ...process.env, FLUJO_SKIP_PATCHRIGHT_DOWNLOAD: '1' } });
    receipt.stages.push(outcome);
    demand(outcome.natural && outcome.exit.code === 0, 'Installation must complete naturally; partial logs retained');
    receipt.state = 'INSTALL_STAGE_COMPLETE_FINALIZATION_PENDING';
  } catch (error) { failure = error; receipt.state = 'INSTALL_FAILED_OR_BOUNDED_TERMINATION'; receipt.error = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    try {
      receipt.afterHead = git(['rev-parse', 'HEAD']); receipt.afterTree = git(['rev-parse', 'HEAD^{tree}']); receipt.afterStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
      receipt.sourceAfter = sourceBefore.map(pin => deadline.bounded('installed source hash ' + pin.file, () => {
        const hash = sha(fs.readFileSync(path.join(root, pin.file)));
        return { file: pin.file, sha256: hash, unchanged: hash === pin.sha256 };
      }));
      receipt.sourceRestored = receipt.afterHead === assigned.head && receipt.afterTree === assigned.tree && receipt.afterStatus === '' && receipt.sourceAfter.every(pin => pin.unchanged);
      demand(receipt.sourceRestored, 'Installation changed assigned source; release refused');
      receipt.state = failure ? 'INSTALL_FAILED_FINALIZED_PENDING_INDEPENDENT_TERMINAL_PROOF' : 'INSTALL_COMPLETED_PENDING_INDEPENDENT_TERMINAL_PROOF';
      persistCandidate(output, 'install.', receipt, deadline);
    } catch (error) {
      failure ??= error;
      receipt.state = 'INSTALL_FINALIZATION_PARTIAL_OR_LATE_RELEASE_HELD';
      preservePartial(output, 'install.', receipt, error);
    }
  }
  if (failure) throw failure;
  deadline.check('install controller terminal handoff');
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
