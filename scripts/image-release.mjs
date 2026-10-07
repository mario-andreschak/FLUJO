import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCurrentMain } from './npm-release.mjs';

export const IMAGE = 'ghcr.io/mario-andreschak/flujo';
export const IMAGE_EVIDENCE = 'image-evidence.json';
export const IMAGE_SBOM = 'image.sbom.cdx.json';
const REPOSITORY = 'mario-andreschak/FLUJO';
const WORKFLOW = `${REPOSITORY}/.github/workflows/publish-image.yml`;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function assertImageContext(env, sha, version) {
  if (!SHA.test(sha) || !VERSION.test(version) || env.GITHUB_REPOSITORY !== REPOSITORY
      || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.GITHUB_WORKFLOW_REF !== `${WORKFLOW}@refs/heads/main` || env.GITHUB_WORKFLOW_SHA !== sha
      || (env.RELEASE_SHA && env.RELEASE_SHA !== sha) || (env.RELEASE_VERSION && env.RELEASE_VERSION !== version)) {
    throw new Error('Image publication requires the official main workflow and exact source/version.');
  }
}

function requiredImageLabels(sha, version) {
  return { 'io.flujo.application.version': version, 'org.opencontainers.image.version': version,
    'org.opencontainers.image.revision': sha, 'org.opencontainers.image.source': `https://github.com/${REPOSITORY}`,
    'io.flujo.snapshot.format': '2', 'io.flujo.workspace.layout': '2', 'io.flujo.worker.protocol': '1',
    'io.flujo.worker.snapshot-source': '1' };
}

function assertImageLabels(actual, sha, version, subject) {
  for (const [key, value] of Object.entries(requiredImageLabels(sha, version))) {
    if (actual?.[key] !== value) throw new Error(`${subject} has an incorrect ${key} label.`);
  }
}

export function inspectTestedImage(run, imageId, sha, version) {
  if (!DIGEST.test(imageId) || !SHA.test(sha) || !VERSION.test(version)) throw new Error('Invalid tested image/source identity.');
  const images = JSON.parse(run('docker', ['image', 'inspect', imageId]));
  const image = images[0];
  if (images.length !== 1 || image?.Id !== imageId || image.Os !== 'linux' || image.Architecture !== 'amd64' || image.Config?.User !== 'node') {
    throw new Error('Tested image must be a single Linux/amd64 image running as node.');
  }
  const labels = requiredImageLabels(sha, version);
  assertImageLabels(image.Config.Labels, sha, version, 'Tested image');
  return { imageId, platform: 'linux/amd64', user: 'node', labels };
}

export function remoteImageConfig(run, reference) {
  let manifest;
  try { manifest = JSON.parse(run('docker', ['manifest', 'inspect', reference])); }
  catch (error) {
    // Authentication, transport and malformed metadata cannot mean absent.
    if (/^(?:Error response from daemon: )?(?:manifest unknown(?:: manifest unknown)?|no such manifest: \S+)\s*$/i.test(String(error.stderr))) return null;
    throw error;
  }
  if (manifest.schemaVersion !== 2 || !DIGEST.test(manifest.config?.digest)) {
    throw new Error('Registry image is not the expected single-platform manifest.');
  }
  return manifest.config.digest;
}

/** Resume the original revision image rather than rebuilding different bytes. */
export function selectImageCandidate({ run, sha, version }) {
  if (!SHA.test(sha) || !VERSION.test(version)) throw new Error('Invalid image candidate identity.');
  const reference = `${IMAGE}:sha-${sha}`;
  const expectedId = remoteImageConfig(run, reference);
  if (!expectedId) return { existing: false, imageId: '' };
  run('docker', ['pull', reference], { timeout: 15 * 60_000 });
  const imageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', reference]).trim();
  if (imageId !== expectedId) throw new Error('Revision image changed during candidate selection.');
  inspectTestedImage(run, imageId, sha, version);
  const repoDigests = JSON.parse(run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', reference]));
  const digests = [...new Set(repoDigests.filter((item) => item.startsWith(`${IMAGE}@`)).map((item) => item.slice(IMAGE.length + 1)))];
  if (digests.length !== 1 || !DIGEST.test(digests[0])) throw new Error('Original revision image has no unambiguous registry digest.');
  // Labels do not prove that an earlier registry image was built from this
  // source. An unsigned partial candidate cannot acquire provenance by reuse.
  verifySignature(run, `oci://${IMAGE}@${digests[0]}`, sha, 'https://slsa.dev/provenance/v1');
  return { existing: true, imageId };
}

function pushDigest(run, imageId, reference) {
  run('docker', ['tag', imageId, reference]);
  const output = run('docker', ['push', reference], { timeout: 15 * 60_000 });
  const matches = [...output.matchAll(/\bdigest: (sha256:[a-f0-9]{64})\b/g)];
  if (matches.length !== 1) throw new Error('Registry did not confirm one published manifest digest.');
  return matches[0][1];
}

function verifyRegistryBytes(run, digest, imageId, sha, version) {
  if (remoteImageConfig(run, `${IMAGE}@${digest}`) !== imageId) throw new Error('Registry manifest differs from the tested image configuration.');
  run('docker', ['pull', `${IMAGE}@${digest}`], { timeout: 15 * 60_000 });
  const downloadedId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', `${IMAGE}@${digest}`]).trim();
  if (downloadedId !== imageId) throw new Error('Registry readback differs from the tested image.');
  inspectTestedImage(run, downloadedId, sha, version);
}

function assertImageSbom(sbom) {
  if (sbom?.bomFormat !== 'CycloneDX' || !['1.5', '1.6'].includes(sbom.specVersion)
      || !Array.isArray(sbom.components) || !sbom.components.some((component) => component.purl?.startsWith('pkg:deb/'))
      || !sbom.components.some((component) => component.purl?.startsWith('pkg:npm/'))) {
    throw new Error('Image inventory must include both Debian OS and installed npm components.');
  }
}

export function prepareImageEvidence({ run, directory, imageId, sha, version, sourceLock, env = {}, assertCurrent = () => assertCurrentMain(run, sha) }) {
  const image = inspectTestedImage(run, imageId, sha, version);
  const sbomPath = path.join(directory, IMAGE_SBOM);
  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
  assertImageSbom(sbom);
  const revision = `${IMAGE}:sha-${sha}`;
  const previousId = remoteImageConfig(run, revision);
  if (previousId && previousId !== imageId) throw new Error('Revision image already exists with different bytes; resume and retest that original image.');
  assertCurrent();
  const digest = pushDigest(run, imageId, revision);
  verifyRegistryBytes(run, digest, imageId, sha, version);
  sbom.metadata ??= {};
  sbom.metadata.properties = [...(sbom.metadata.properties ?? []),
    { name: 'flujo:image:config-digest', value: imageId }, { name: 'flujo:image:manifest-digest', value: digest },
    { name: 'flujo:source:revision', value: sha },
    { name: 'flujo:inventory:scope', value: 'tested container filesystem OS and installed application packages; future runtime-installed MCP packages excluded' }];
  const sbomBytes = json(sbom);
  writeFileSync(sbomPath, sbomBytes);
  const evidence = { schemaVersion: 1, repository: REPOSITORY, source: sha, version, image: IMAGE, digest, ...image,
    sourceLockSha256: hash(sourceLock), sbom: { filename: IMAGE_SBOM, sha256: hash(sbomBytes), scope: 'container OS and installed application packages; future runtime-installed MCP packages excluded' },
    workflow: { ref: env.GITHUB_WORKFLOW_REF ?? null, sha: env.GITHUB_WORKFLOW_SHA ?? null,
      runId: env.GITHUB_RUN_ID ?? null, attempt: env.GITHUB_RUN_ATTEMPT ?? null } };
  writeFileSync(path.join(directory, IMAGE_EVIDENCE), json(evidence));
  return validateImageEvidence({ directory, sha, version, sourceLock });
}

export function validateImageEvidence({ directory, sha, version, sourceLock, expectedDigest }) {
  const evidence = JSON.parse(readFileSync(path.join(directory, IMAGE_EVIDENCE), 'utf8'));
  const sbomBytes = readFileSync(path.join(directory, IMAGE_SBOM));
  assertImageSbom(JSON.parse(sbomBytes));
  if (!SHA.test(sha) || !VERSION.test(version) || evidence.schemaVersion !== 1 || evidence.repository !== REPOSITORY
      || evidence.source !== sha || evidence.version !== version || evidence.image !== IMAGE || !DIGEST.test(evidence.digest)
      || !DIGEST.test(evidence.imageId) || evidence.platform !== 'linux/amd64' || evidence.user !== 'node'
      || (expectedDigest && evidence.digest !== expectedDigest)
      || evidence.sourceLockSha256 !== hash(sourceLock) || evidence.sbom?.filename !== IMAGE_SBOM || evidence.sbom.sha256 !== hash(sbomBytes)
      || (evidence.workflow?.ref && (evidence.workflow.ref !== `${WORKFLOW}@refs/heads/main` || evidence.workflow.sha !== sha))) {
    throw new Error('Image evidence differs from the requested source or tested inventory.');
  }
  assertImageLabels(evidence.labels, sha, version, 'Image evidence');
  return evidence;
}

function verifySignature(run, subject, sha, predicate) {
  run('gh', ['attestation', 'verify', subject, '--repo', REPOSITORY, '--predicate-type', predicate,
    '--signer-workflow', WORKFLOW,
    '--cert-identity', `https://github.com/${WORKFLOW}@refs/heads/main`,
    '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com', '--source-digest', sha, '--source-ref', 'refs/heads/main', '--signer-digest', sha,
    '--deny-self-hosted-runners'], { stdio: 'inherit' });
}

export function promoteTestedImage({ run, directory, sha, version, sourceLock, expectedDigest, assertCurrent = () => assertCurrentMain(run, sha) }) {
  const evidence = validateImageEvidence({ directory, sha, version, sourceLock, expectedDigest });
  for (const file of [IMAGE_EVIDENCE, IMAGE_SBOM]) verifySignature(run, path.join(directory, file), sha, 'https://slsa.dev/provenance/v1');
  const subject = `oci://${IMAGE}@${evidence.digest}`;
  verifySignature(run, subject, sha, 'https://slsa.dev/provenance/v1');
  verifySignature(run, subject, sha, 'https://cyclonedx.org/bom');
  verifyRegistryBytes(run, evidence.digest, evidence.imageId, sha, version);
  // Check all immutable aliases before making a mutable channel write.
  const aliases = [`${IMAGE}:${version}`, `${IMAGE}:sha-${sha.slice(0, 7)}`];
  for (const alias of aliases) {
    const existingId = remoteImageConfig(run, alias);
    if (existingId && existingId !== evidence.imageId) throw new Error(`Image alias ${alias} already identifies different bytes.`);
  }
  for (const alias of [...aliases, `${IMAGE}:latest`]) {
    assertCurrent();
    if (pushDigest(run, evidence.imageId, alias) !== evidence.digest) throw new Error('Promoted alias manifest differs from the signed tested digest.');
  }
  return evidence;
}

const execute = (command, args, options = {}) => {
  const output = execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options });
  return typeof output === 'string' ? output.trim() : '';
};

function main() {
  const mode = process.argv[2];
  const env = process.env;
  const sha = env.GITHUB_SHA;
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  assertImageContext(env, sha, version);
  if (execute('git', ['rev-parse', 'HEAD']) !== sha) throw new Error('Image workflow checkout differs from its source.');
  if (execute('git', ['status', '--porcelain']) !== '') throw new Error('Image workflow source checkout is dirty.');
  assertCurrentMain(execute, sha);
  if (mode === 'select') {
    const selected = selectImageCandidate({ run: execute, sha, version });
    appendFileSync(env.GITHUB_OUTPUT, `existing=${selected.existing}\nimage_id=${selected.imageId}\n`);
    return;
  }
  const directory = env.IMAGE_EVIDENCE_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute image evidence directory is required.');
  if (['validate', 'promote'].includes(mode) && !DIGEST.test(env.EXPECTED_IMAGE_DIGEST ?? '')) {
    throw new Error('The original candidate job manifest digest is required.');
  }
  const input = { run: execute, directory, sha, version, sourceLock: readFileSync('package-lock.json'), env, expectedDigest: env.EXPECTED_IMAGE_DIGEST };
  const evidence = mode === 'candidate' ? prepareImageEvidence({ ...input, imageId: env.TESTED_IMAGE_ID })
    : mode === 'validate' ? validateImageEvidence(input) : mode === 'promote' ? promoteTestedImage(input) : null;
  if (!evidence) throw new Error('Expected select, candidate, validate or promote phase.');
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `digest=${evidence.digest}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`Image publication refused: ${error.message}`); process.exitCode = 1; }
}
