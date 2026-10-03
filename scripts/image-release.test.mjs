import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { IMAGE, IMAGE_EVIDENCE, IMAGE_SBOM, assertImageContext, inspectTestedImage, remoteImageConfig,
  selectImageCandidate, prepareImageEvidence, validateImageEvidence, promoteTestedImage } from './image-release.mjs';

const sha = 'a'.repeat(40);
const imageId = `sha256:${'b'.repeat(64)}`;
const digest = `sha256:${'c'.repeat(64)}`;
const otherId = `sha256:${'d'.repeat(64)}`;
const version = '3.46.2';
const sourceLock = Buffer.from('{"synthetic":"source lock"}');
const env = { GITHUB_REPOSITORY: 'mario-andreschak/FLUJO', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'mario-andreschak/FLUJO/.github/workflows/publish-image.yml@refs/heads/main', GITHUB_WORKFLOW_SHA: sha };
const labels = { 'io.flujo.application.version': version, 'org.opencontainers.image.version': version,
  'org.opencontainers.image.revision': sha, 'org.opencontainers.image.source': 'https://github.com/mario-andreschak/FLUJO',
  'io.flujo.snapshot.format': '2', 'io.flujo.workspace.layout': '2', 'io.flujo.worker.protocol': '1' };

function runner(options = {}) {
  const calls = [];
  const remote = new Map(options.remote || []);
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === 'gh') {
      if (args[0] === 'api') return sha;
      if (options.signatureFailure) throw new Error('signature refused');
      return '';
    }
    assert.equal(command, 'docker');
    if (args[0] === 'manifest') {
      const reference = args[2];
      if (options.manifestFailure) throw options.manifestFailure;
      const config = reference === `${IMAGE}@${digest}` ? (options.readbackId || imageId) : remote.get(reference);
      if (!config) throw Object.assign(new Error('absent'), { stderr: 'manifest unknown: manifest unknown' });
      return JSON.stringify({ schemaVersion: 2, config: { digest: config } });
    }
    if (args[0] === 'image' && args[2] === '--format') return args[3] === '{{json .RepoDigests}}'
      ? JSON.stringify(options.repoDigests || [`${IMAGE}@${digest}`]) : options.selectedId || imageId;
    if (args[0] === 'image') return JSON.stringify([{ Id: imageId, Os: 'linux', Architecture: 'amd64',
      Config: { User: 'node', Labels: labels, Env: ['SYNTHETIC_SECRET=private-image-value'] }, ...options.image }]);
    if (args[0] === 'pull' || args[0] === 'tag') return '';
    assert.equal(args[0], 'push');
    remote.set(args[1], imageId);
    return options.pushOutput || `${args[1]}: digest: ${digest} size: 1234`;
  };
  return { run, calls, remote };
}

function fixture(t, options) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flujo-image-evidence-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const sbom = { bomFormat: 'CycloneDX', specVersion: '1.6', components: [
    { type: 'library', name: 'synthetic-libc', purl: 'pkg:deb/debian/synthetic-libc@1' },
    { type: 'library', name: 'synthetic-npm', purl: 'pkg:npm/synthetic-npm@1' },
  ] };
  writeFileSync(path.join(directory, IMAGE_SBOM), JSON.stringify(sbom));
  return { directory, imageId, sha, version, sourceLock, env, ...runner(options) };
}

test('image source context refuses forks, other refs, workflows, revisions and requested versions', () => {
  assertImageContext(env, sha, version);
  for (const changes of [{ GITHUB_REPOSITORY: 'other/FLUJO' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_SHA: 'd'.repeat(40) }, { RELEASE_SHA: 'd'.repeat(40) }, { RELEASE_VERSION: '3.46.3' }]) {
    assert.throws(() => assertImageContext({ ...env, ...changes }, sha, version));
  }
});

test('tested configuration requires non-root Linux/amd64 source and compatibility labels', () => {
  assert.equal(inspectTestedImage(runner().run, imageId, sha, version).imageId, imageId);
  for (const image of [{ Id: otherId }, { Os: 'windows' }, { Architecture: 'arm64' },
    { Config: { User: 'root', Labels: labels } }, { Config: { User: 'node', Labels: { ...labels, 'io.flujo.worker.protocol': '2' } } }]) {
    assert.throws(() => inspectTestedImage(runner({ image }).run, imageId, sha, version));
  }
});

test('a missing revision selects one new build; a retry pulls and validates the original image', () => {
  const missing = runner();
  assert.deepEqual(selectImageCandidate({ ...missing, sha, version }), { existing: false, imageId: '' });
  assert.equal(missing.calls.some(({ args }) => args[0] === 'pull'), false);
  const existing = runner({ remote: [[`${IMAGE}:sha-${sha}`, imageId]] });
  assert.deepEqual(selectImageCandidate({ ...existing, sha, version }), { existing: true, imageId });
  assert.equal(existing.calls.filter(({ args }) => args[0] === 'pull').length, 1);
  assert.equal(existing.calls.filter(({ command, args }) => command === 'gh' && args[0] === 'attestation').length, 1);
  assert.throws(() => selectImageCandidate({ ...runner({ remote: [[`${IMAGE}:sha-${sha}`, imageId]], selectedId: otherId }), sha, version }), /changed/);
});

test('an unsigned or ambiguous existing revision cannot acquire provenance through reuse', () => {
  const remote = [[`${IMAGE}:sha-${sha}`, imageId]];
  assert.throws(() => selectImageCandidate({ ...runner({ remote, signatureFailure: true }), sha, version }), /signature refused/);
  assert.throws(() => selectImageCandidate({ ...runner({ remote, repoDigests: [] }), sha, version }), /unambiguous registry digest/);
});

test('registry auth, transport and malformed manifests cannot masquerade as missing images', () => {
  for (const failure of [new Error('malformed JSON'), Object.assign(new Error('auth'), { stderr: 'unauthorized: authentication required' }),
    Object.assign(new Error('transport'), { stderr: 'manifest unknown: connection reset' })]) {
    assert.throws(() => remoteImageConfig(runner({ manifestFailure: failure }).run, `${IMAGE}:sha-${sha}`));
  }
});

test('candidate writes only the tested revision and retains actual registry digest and scoped OS inventory', (t) => {
  const f = fixture(t);
  const evidence = prepareImageEvidence(f);
  assert.equal(evidence.digest, digest);
  assert.equal(evidence.imageId, imageId);
  assert.equal(f.calls.filter(({ args }) => args[0] === 'push').length, 1);
  assert.equal(f.calls.find(({ args }) => args[0] === 'push').args[1], `${IMAGE}:sha-${sha}`);
  assert.equal(f.calls.some(({ args }) => args[0] === 'build'), false);
  assert.match(evidence.sbom.scope, /future runtime-installed MCP.*excluded/);
  assert.doesNotMatch(readFileSync(path.join(f.directory, IMAGE_EVIDENCE), 'utf8'), /private-image-value|SYNTHETIC_SECRET/);
  assert.deepEqual(validateImageEvidence(f), evidence);
});

test('candidate refuses an existing different revision before registry mutation', (t) => {
  const f = fixture(t, { remote: [[`${IMAGE}:sha-${sha}`, otherId]] });
  assert.throws(() => prepareImageEvidence(f), /different bytes/);
  assert.equal(f.calls.some(({ args }) => args[0] === 'tag' || args[0] === 'push'), false);
});

test('wrong registry readback or ambiguous push digests cannot produce release evidence', (t) => {
  for (const options of [{ readbackId: otherId }, { pushOutput: 'no digest' }, { pushOutput: `digest: ${digest}\ndigest: ${digest}` }]) {
    const f = fixture(t, options);
    assert.throws(() => prepareImageEvidence(f));
  }
});

for (const field of ['source', 'version', 'digest', 'imageId', 'sourceLockSha256']) {
  test(`image evidence rejects changed ${field}`, (t) => {
    const f = fixture(t);
    const evidence = prepareImageEvidence(f);
    evidence[field] = 'wrong';
    writeFileSync(path.join(f.directory, IMAGE_EVIDENCE), JSON.stringify(evidence));
    assert.throws(() => validateImageEvidence(f));
  });
}

test('source-lock and inventory tampering are refused', (t) => {
  const f = fixture(t);
  prepareImageEvidence(f);
  assert.throws(() => validateImageEvidence({ ...f, sourceLock: Buffer.from('changed') }));
  writeFileSync(path.join(f.directory, IMAGE_SBOM), '{}');
  assert.throws(() => validateImageEvidence(f));
});

test('promotion verifies every signature before mutation and every alias retains the signed digest', (t) => {
  const f = fixture(t);
  prepareImageEvidence(f);
  f.calls.length = 0;
  promoteTestedImage(f);
  const signatures = f.calls.filter(({ command, args }) => command === 'gh' && args[0] === 'attestation');
  assert.equal(signatures.length, 4);
  for (const { args } of signatures) {
    assert.equal(args[args.indexOf('--source-digest') + 1], sha);
    assert.equal(args[args.indexOf('--signer-digest') + 1], sha);
    assert.equal(args[args.indexOf('--source-ref') + 1], 'refs/heads/main');
    assert.equal(args[args.indexOf('--signer-workflow') + 1], 'mario-andreschak/FLUJO/.github/workflows/publish-image.yml');
    assert.ok(args.includes('--deny-self-hosted-runners'));
  }
  const firstTag = f.calls.findIndex(({ args }) => args[0] === 'tag');
  assert.equal(f.calls.slice(0, firstTag).filter(({ command, args }) => command === 'gh' && args[0] === 'attestation').length, 4);
  assert.deepEqual(f.calls.filter(({ args }) => args[0] === 'push').map(({ args }) => args[1]),
    [`${IMAGE}:${version}`, `${IMAGE}:sha-${sha.slice(0, 7)}`, `${IMAGE}:latest`]);
  assert.equal(f.calls.some(({ args }) => args[0] === 'build'), false);
});

test('a failed signature stops before any promotion or download', (t) => {
  const f = fixture(t);
  prepareImageEvidence(f);
  const bad = runner({ signatureFailure: true });
  assert.throws(() => promoteTestedImage({ ...f, run: bad.run }), /signature refused/);
  assert.equal(bad.calls.some(({ command }) => command === 'docker'), false);
});

test('the original candidate job digest is checked before signatures or registry mutations', (t) => {
  const f = fixture(t);
  prepareImageEvidence(f);
  f.calls.length = 0;
  assert.throws(() => promoteTestedImage({ ...f, expectedDigest: otherId }), /tested inventory/);
  assert.deepEqual(f.calls, []);
});

test('all immutable aliases are checked before latest can advance', (t) => {
  const f = fixture(t);
  prepareImageEvidence(f);
  f.calls.length = 0;
  f.remote.set(`${IMAGE}:sha-${sha.slice(0, 7)}`, otherId);
  assert.throws(() => promoteTestedImage(f), /different bytes/);
  assert.equal(f.calls.some(({ args }) => args[0] === 'tag' || args[0] === 'push'), false);
});

test('a moved main or altered promoted manifest fails closed', (t) => {
  const f = fixture(t);
  prepareImageEvidence(f);
  f.calls.length = 0;
  assert.throws(() => promoteTestedImage({ ...f, assertCurrent: () => { throw new Error('main moved'); } }), /main moved/);
  assert.equal(f.calls.some(({ args }) => args[0] === 'push'), false);
  const changed = runner({ pushOutput: `digest: ${otherId}` });
  assert.throws(() => promoteTestedImage({ ...f, run: changed.run }), /signed tested digest/);
  assert.equal(changed.calls.filter(({ args }) => args[0] === 'push').length, 1);
});

test('image workflow builds once, signs separately and promotes its original artifact without executing candidate code', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/publish-image.yml', import.meta.url), 'utf8'));
  const { candidate, attest, publish } = workflow.jobs;
  const builds = Object.values(workflow.jobs).flatMap(({ steps }) => steps.filter(({ uses }) => uses?.startsWith('docker/build-push-action@')));
  assert.equal(builds.length, 1);
  assert.equal(builds[0].with.push, false);
  assert.equal(builds[0].with.load, true);
  assert.equal(builds[0].with.platforms, 'linux/amd64');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(publish.needs, ['candidate', 'attest']);
  assert.equal(attest.needs, 'candidate');
  for (const job of [candidate, publish]) assert.notEqual(job.permissions['id-token'], 'write');
  assert.equal(attest.permissions.attestations, 'write');
  assert.equal(attest.steps.some(({ run }) => /npm (?:ci|run build)|docker run/.test(run ?? '')), false);
  for (const job of [attest, publish]) {
    const download = job.steps.find(({ uses }) => uses?.startsWith('actions/download-artifact@'));
    assert.equal(download.with['artifact-ids'], '${{ needs.candidate.outputs.artifact_id }}');
  }
  const sbom = candidate.steps.find(({ uses }) => uses?.startsWith('anchore/sbom-action@'));
  assert.equal(sbom.with.image, 'docker:${{ steps.smoke.outputs.image_id }}');
  assert.equal(sbom.with['upload-release-assets'], false);
  assert.equal(sbom.with['syft-version'], 'v1.54.0');
  const npm = YAML.parse(readFileSync(new URL('../.github/workflows/publish-npm.yml', import.meta.url), 'utf8'));
  const imageBudget = candidate['timeout-minutes'] + attest['timeout-minutes'] + publish['timeout-minutes'];
  assert.ok(npm.jobs.finalize['timeout-minutes'] > imageBudget + 10,
    'npm finalization must accommodate the awaited image workflow and its own setup/registry checks');
});
