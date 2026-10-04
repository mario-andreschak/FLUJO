import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_PACKAGES } from './release-packages.mjs';

const REPOSITORY = 'mario-andreschak/FLUJO';
const WORKFLOW = `${REPOSITORY}/.github/workflows/publish-npm.yml`;
export const EVIDENCE_FILE = 'release-evidence.json';
export const SBOM_FILE = 'source-lock.sbom.cdx.json';
export const CHECKSUM_FILE = 'SHA256SUMS';
const SHA = /^[a-f0-9]{40}$/;
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function inventory(directory, sha, version) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (!SHA.test(sha) || !/^\d+\.\d+\.\d+$/.test(version) || manifest.schemaVersion !== 1
      || manifest.revision !== sha || manifest.version !== version || manifest.packages?.length !== PUBLIC_PACKAGES.length) {
    throw new Error('Distribution manifest does not identify the requested release.');
  }
  const filenames = new Set();
  return manifest.packages.map((item, index) => {
    if (item.name !== PUBLIC_PACKAGES[index] || typeof item.filename !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/.test(item.filename)
        || filenames.has(item.filename)) throw new Error('Invalid distribution package identity or path.');
    filenames.add(item.filename);
    const bytes = readFileSync(path.join(directory, item.filename));
    const integrity = `sha512-${digest(bytes, 'sha512', 'base64')}`;
    if (!bytes.length || integrity !== item.integrity) throw new Error('Distribution bytes differ from the tested manifest.');
    return { name: item.name, version, filename: item.filename, size: bytes.length, integrity, sha256: digest(bytes) };
  });
}

function assertSbom(sbom, version) {
  const component = sbom?.metadata?.component;
  // npm/Arborist may use the checkout folder as the root display name. Its
  // canonical Package URL still identifies the package in the source lock.
  const rootIdentity = component?.purl === `pkg:npm/flujo-ai@${version}`
    || (!component?.purl && component?.name === 'flujo-ai');
  if (sbom?.bomFormat !== 'CycloneDX' || !['1.5', '1.6'].includes(sbom.specVersion)
      || !rootIdentity || component.version !== version
      || !Array.isArray(sbom.components) || !sbom.components.length) throw new Error('Invalid source-lock CycloneDX inventory.');
}

function assertSourceLock(bytes, version) {
  const lock = JSON.parse(bytes);
  if (lock.name !== 'flujo-ai' || lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('Source lockfile version differs from the distribution.');
  }
  for (const item of Object.values(lock.packages)) {
    if (typeof item.resolved !== 'string' || !/^https?:/.test(item.resolved)) continue;
    const url = new URL(item.resolved);
    if (url.username || url.password) throw new Error('Source lockfile contains registry credentials; refusing evidence export.');
  }
}

function checksums(directory, artifacts) {
  const files = [...artifacts.map((item) => item.filename), 'manifest.json', EVIDENCE_FILE, SBOM_FILE].sort();
  return `${files.map((file) => `${digest(readFileSync(path.join(directory, file)))}  ${file}`).join('\n')}\n`;
}

export function writeReleaseEvidence({ directory, sha, version, sourceLock, sbom, runtime, env = {} }) {
  const artifacts = inventory(directory, sha, version);
  assertSourceLock(sourceLock, version);
  assertSbom(sbom, version);
  if (env.GITHUB_SHA && (env.GITHUB_SHA !== sha || env.GITHUB_REPOSITORY !== REPOSITORY
      || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_WORKFLOW_REF !== `${WORKFLOW}@refs/heads/main`
      || env.GITHUB_WORKFLOW_SHA !== sha)) {
    throw new Error('Evidence workflow identity differs from the release source.');
  }
  const scopedSbom = structuredClone(sbom);
  scopedSbom.metadata.lifecycles = [{ phase: 'build' }];
  scopedSbom.metadata.properties = [...(scopedSbom.metadata.properties ?? []),
    { name: 'flujo:inventory:scope', value: 'source lockfile including development/build dependencies; consumer resolution and runtime-installed MCP packages excluded' },
    { name: 'flujo:source:revision', value: sha }, { name: 'flujo:source:lock-sha256', value: digest(sourceLock) }];
  const sbomBytes = json(scopedSbom);
  writeFileSync(path.join(directory, SBOM_FILE), sbomBytes);
  const evidence = {
    schemaVersion: 1, repository: REPOSITORY, revision: sha, version,
    sourceLock: { sha256: digest(sourceLock) },
    sbom: { filename: SBOM_FILE, sha256: digest(sbomBytes), scope: 'source lockfile, including build/development dependencies; consumer resolution and runtime-installed MCP packages excluded' },
    artifacts,
    runtime: { node: runtime.node, npm: runtime.npm, platform: runtime.platform, architecture: runtime.architecture },
    workflow: { ref: env.GITHUB_WORKFLOW_REF ?? null, sha: env.GITHUB_WORKFLOW_SHA ?? null,
      runId: env.GITHUB_RUN_ID ?? null, attempt: env.GITHUB_RUN_ATTEMPT ?? null },
  };
  writeFileSync(path.join(directory, EVIDENCE_FILE), json(evidence));
  writeFileSync(path.join(directory, CHECKSUM_FILE), checksums(directory, artifacts));
  return validateReleaseEvidence({ directory, sha, version, sourceLock });
}

export function prepareReleaseEvidence({ run, directory, sha, version, sourceRoot = process.cwd(), env = process.env }) {
  const sourceLock = readFileSync(path.join(sourceRoot, 'package-lock.json'));
  assertSourceLock(sourceLock, version);
  const sbom = JSON.parse(run('npm', ['sbom', '--sbom-format=cyclonedx', '--package-lock-only', '--include=dev', '--offline', '--ignore-scripts'], { cwd: sourceRoot }));
  return writeReleaseEvidence({ directory, sha, version, sourceLock, sbom, env,
    runtime: { node: process.version, npm: run('npm', ['--version']), platform: process.platform, architecture: process.arch } });
}

/** Internal consistency and expected-source checks; cryptographic signer verification is separate. */
export function validateReleaseEvidence({ directory, sha, version, sourceLock }) {
  const artifacts = inventory(directory, sha, version);
  const evidence = JSON.parse(readFileSync(path.join(directory, EVIDENCE_FILE), 'utf8'));
  const sbomBytes = readFileSync(path.join(directory, SBOM_FILE));
  assertSbom(JSON.parse(sbomBytes), version);
  if (evidence.schemaVersion !== 1 || evidence.repository !== REPOSITORY || evidence.revision !== sha || evidence.version !== version
      || JSON.stringify(evidence.artifacts) !== JSON.stringify(artifacts)
      || !/^[a-f0-9]{64}$/.test(evidence.sourceLock?.sha256 ?? '')
      || evidence.sbom?.filename !== SBOM_FILE || evidence.sbom.sha256 !== digest(sbomBytes)
      || !/^v\d+\.\d+\.\d+/.test(evidence.runtime?.node ?? '') || !/^\d+\.\d+\.\d+/.test(evidence.runtime?.npm ?? '')
      || !['linux', 'win32', 'darwin'].includes(evidence.runtime?.platform)
      || (evidence.workflow?.ref && (evidence.workflow.ref !== `${WORKFLOW}@refs/heads/main` || evidence.workflow.sha !== sha))
      || (sourceLock && evidence.sourceLock.sha256 !== digest(sourceLock))) {
    throw new Error('Release evidence does not match the tested bytes and expected source.');
  }
  if (sourceLock) assertSourceLock(sourceLock, version);
  if (readFileSync(path.join(directory, CHECKSUM_FILE), 'utf8') !== checksums(directory, artifacts)) {
    throw new Error('Release checksums differ from the full expected distribution inventory.');
  }
  return evidence;
}

export function verifyReleaseAttestations({ run, directory, sha, version, sourceLock }) {
  const evidence = validateReleaseEvidence({ directory, sha, version, sourceLock });
  for (const file of [...evidence.artifacts.map((item) => item.filename), 'manifest.json', EVIDENCE_FILE, SBOM_FILE]) {
    run('gh', ['attestation', 'verify', path.join(directory, file), '--repo', REPOSITORY,
      '--predicate-type', 'https://slsa.dev/provenance/v1',
      '--cert-identity', `https://github.com/${WORKFLOW}@refs/heads/main`,
      '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
      '--source-digest', sha, '--source-ref', 'refs/heads/main',
      '--signer-digest', sha,
      '--deny-self-hosted-runners'], { stdio: 'inherit' });
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, directory, sha, version, sourceRoot] = process.argv.slice(2);
    if (mode !== 'validate' || !directory) throw new Error('Expected: validate <candidate-directory> <source-SHA> <version> [source-checkout]');
    const evidence = validateReleaseEvidence({ directory, sha, version,
      sourceLock: sourceRoot ? readFileSync(path.join(sourceRoot, 'package-lock.json')) : undefined });
    console.log(`Distribution consistency verified for ${evidence.revision}; cryptographic attestation verification remains required.`);
  } catch (error) { console.error(`Distribution evidence refused: ${error.message}`); process.exitCode = 1; }
}
