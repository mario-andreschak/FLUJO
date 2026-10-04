import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePublicationContext } from './require-release-verification.mjs';

export const INSTALLER_FILE = 'flujo-setup.exe';
export const INSTALLER_EVIDENCE_FILE = 'installer-release-evidence.json';
export const INSTALLER_CHECKSUM_FILE = 'installer-SHA256SUMS';
const REPOSITORY = 'mario-andreschak/FLUJO';
const WORKFLOW = `${REPOSITORY}/.github/workflows/installer.yml`;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function installerSourceContext({ repository, revision, checkout, ref, version, workflowRef, workflowSha }) {
  validatePublicationContext({ repository, revision, checkout, ref, version, publication: 'installer' });
  if (repository !== REPOSITORY || workflowRef !== `${WORKFLOW}@${ref}` || workflowSha !== revision) {
    throw new Error('Installer evidence requires the official exact-source tag workflow.');
  }
  return { repository, revision, ref, version, workflowRef, workflowSha };
}

function evidenceFor({ revision, version }, bytes) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '') || !/^\d+\.\d+\.\d+$/.test(version ?? '') || bytes.length === 0) {
    throw new Error('Installer evidence requires an exact revision, release version and nonempty executable.');
  }
  const ref = `refs/tags/v${version}`;
  return {
    schemaVersion: 1, repository: REPOSITORY, revision, version, ref,
    workflow: { path: WORKFLOW, ref: `${WORKFLOW}@${ref}`, revision },
    artifact: { filename: INSTALLER_FILE, size: bytes.length, sha256: digest(bytes) },
    scope: 'Bootstrapper bytes only; downloaded application/package dependencies and installed-consumer acceptance are separate evidence.',
  };
}

function checksums(directory, artifactDigest) {
  const metadataDigest = digest(readFileSync(path.join(directory, INSTALLER_EVIDENCE_FILE)));
  return `${artifactDigest}  ${INSTALLER_FILE}\n${metadataDigest}  ${INSTALLER_EVIDENCE_FILE}\n`;
}

// These paths belong to the trusted release build/download workspace. This
// inventory is a byte/source binding, not a general filesystem confinement API.
export function writeInstallerEvidence({ directory, context }) {
  installerSourceContext({ ...context, checkout: context.revision });
  const bytes = readFileSync(path.join(directory, INSTALLER_FILE));
  const evidence = evidenceFor(context, bytes);
  writeFileSync(path.join(directory, INSTALLER_EVIDENCE_FILE), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(path.join(directory, INSTALLER_CHECKSUM_FILE), checksums(directory, evidence.artifact.sha256), { flag: 'wx' });
  return evidence;
}

export function validateInstallerEvidence({ directory, revision, version, expectedDigest }) {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest ?? '')) {
    throw new Error('The original build job installer digest is required.');
  }
  const bytes = readFileSync(path.join(directory, INSTALLER_FILE));
  const expected = evidenceFor({ revision, version }, bytes);
  const evidence = JSON.parse(readFileSync(path.join(directory, INSTALLER_EVIDENCE_FILE), 'utf8'));
  if (expected.artifact.sha256 !== expectedDigest || JSON.stringify(evidence) !== JSON.stringify(expected)
      || readFileSync(path.join(directory, INSTALLER_CHECKSUM_FILE), 'utf8') !== checksums(directory, expectedDigest)) {
    throw new Error('Installer evidence does not match the original executable and exact release source.');
  }
  return evidence;
}

export function verifyInstallerAttestations({ run, ...options }) {
  const evidence = validateInstallerEvidence(options);
  for (const file of [INSTALLER_FILE, INSTALLER_EVIDENCE_FILE]) {
    run('gh', ['attestation', 'verify', path.join(options.directory, file), '--repo', REPOSITORY,
      '--predicate-type', 'https://slsa.dev/provenance/v1', '--signer-workflow', WORKFLOW,
      '--source-digest', options.revision, '--source-ref', `refs/tags/v${options.version}`,
      '--signer-digest', options.revision, '--deny-self-hosted-runners'], { stdio: 'inherit' });
  }
  return evidence;
}

export function writeInstallerDigest({ directory, outputFile }) {
  if (typeof outputFile !== 'string' || outputFile.length === 0) throw new Error('The GitHub output file is required.');
  const bytes = readFileSync(path.join(directory, INSTALLER_FILE));
  if (bytes.length === 0) throw new Error('The installer executable must be nonempty.');
  const sha256 = digest(bytes);
  appendFileSync(outputFile, `sha256=${sha256}\n`, 'utf8');
  return sha256;
}

function main() {
  const run = (command, args, options = {}) => execFileSync(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: 90_000, ...options,
  });
  if (process.argv[2] === 'verify-download') {
    const inputs = process.argv.slice(3);
    if (inputs.length !== 4 || inputs.some((value) => value.length === 0)) {
      throw new Error('verify-download requires <directory> <source-SHA> <version> <executable-SHA256>.');
    }
    const [directory, revision, version, expectedDigest] = inputs;
    const evidence = verifyInstallerAttestations({ directory, revision, version, expectedDigest, run });
    console.log(`Downloaded installer verified for ${evidence.revision} (${evidence.ref}), SHA-256 ${evidence.artifact.sha256}.`);
    return;
  }
  const directory = process.env.INSTALLER_RELEASE_DIR ?? 'installer/Output';
  if (process.argv[2] === 'digest') {
    writeInstallerDigest({ directory, outputFile: process.env.GITHUB_OUTPUT });
    console.log('Original installer byte digest retained in the GitHub output file.');
    return;
  }
  const context = installerSourceContext({
    repository: process.env.GITHUB_REPOSITORY, revision: process.env.GITHUB_SHA,
    checkout: run('git', ['rev-parse', 'HEAD']).trim(), ref: process.env.GITHUB_REF,
    version: JSON.parse(readFileSync('package.json', 'utf8')).version,
    workflowRef: process.env.GITHUB_WORKFLOW_REF, workflowSha: process.env.GITHUB_WORKFLOW_SHA,
  });
  const options = { directory,
    revision: context.revision, version: context.version, expectedDigest: process.env.EXPECTED_INSTALLER_SHA256 };
  switch (process.argv[2]) {
    case 'prepare': writeInstallerEvidence({ directory: options.directory, context }); break;
    case 'validate': validateInstallerEvidence(options); break;
    case 'verify-signatures': verifyInstallerAttestations({ ...options, run }); break;
    default: throw new Error('Use digest, prepare, validate, verify-signatures or verify-download.');
  }
  console.log(`Installer ${process.argv[2]} succeeded for ${context.revision} (${context.ref}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`Installer release refused: ${error.message}`); process.exitCode = 1; }
}
