'use strict';
// PREPARED ONLY. This optional hosted-route controller requires its own explicit
// installation authorization. It shares the witness birth-aware stage watchdog.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { birth, stage, sha, demand } = require('./run.cjs');
async function main() {
  const assignedBytes = fs.readFileSync(process.argv[2]);
  const assigned = JSON.parse(assignedBytes);
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
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();
  demand(git(['rev-parse', 'HEAD']) === 'f67f215d2c698f961d28efdb50267454b4b1faf6' && git(['rev-parse', 'HEAD^{tree}']) === 'd09c5ccdd5a85d6e41061ecef683a0996d938c8e' && git(['status', '--porcelain=v1', '--untracked-files=all']) === '', 'Clean failed source required before installation');
  const sourceBefore = JSON.parse(fs.readFileSync(path.join(__dirname, 'current-source-pins.json'))).sourceComparison.pins.filter(pin => pin.role === 'traced append input').map(pin => ({ file: pin.file, gitBlob: pin.gitBlob, sha256: sha(fs.readFileSync(path.join(root, pin.file))) }));
  demand(sourceBefore.length === 19 && !fs.existsSync(path.join(root, 'node_modules')), 'Fresh19-input owned hosted target without an existing graph required');
  const receipt = { schemaVersion: 1, state: 'INSTALL_ENTERED_NO_WITNESS_YET', count: assigned.count, head: assigned.head, tree: assigned.tree, assignmentSha256: sha(assignedBytes), packetManifestSha256: sha(manifestBytes), controller: birth(process.pid), bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), sourceBefore, stages: [], enteredAtUtc: new Date().toISOString() };
  let failure;
  try {
    demand(Date.parse(assigned.notBeforeUtc) <= Date.now() && Date.parse(assigned.expiresAtUtc) > Date.now() + 410_000, 'At least410s assigned time remaining required before installation plus witness');
    const outcome = await stage('install', [assigned.npmCli, 'ci', '--include=dev'], 180_000, { root, output, environment: { ...process.env, FLUJO_SKIP_PATCHRIGHT_DOWNLOAD: '1' } });
    receipt.stages.push(outcome);
    demand(outcome.natural && outcome.exit.code === 0, 'Installation must complete naturally; partial logs retained');
    receipt.state = 'INSTALL_COMPLETED_NATURALLY_NO_WITNESS_QUALIFICATION';
  } catch (error) { failure = error; receipt.state = 'INSTALL_FAILED_OR_BOUNDED_TERMINATION'; receipt.error = { name: error.name, message: error.message, stack: error.stack }; }
  finally {
    receipt.afterHead = git(['rev-parse', 'HEAD']); receipt.afterTree = git(['rev-parse', 'HEAD^{tree}']); receipt.afterStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
    receipt.sourceRestored = receipt.afterHead === assigned.head && receipt.afterTree === assigned.tree && receipt.afterStatus === '' && sourceBefore.every(pin => sha(fs.readFileSync(path.join(root, pin.file))) === pin.sha256);
    receipt.endedAtUtc = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'install.receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const members = fs.readdirSync(output, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => { const bytes = fs.readFileSync(path.join(output, entry.name)); return { file: entry.name, bytes: bytes.length, sha256: sha(bytes) }; });
    fs.writeFileSync(path.join(output, 'install.manifest.json'), JSON.stringify({ schemaVersion: 1, members }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    demand(receipt.sourceRestored, 'Installation changed assigned source; release refused');
  }
  if (failure) throw failure;
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
