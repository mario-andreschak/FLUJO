import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fetchNpmProvenance, verifyNpmProvenance } from './maintainer-npm-provenance.mjs';

const revision = 'a'.repeat(40);
const options = { version: '3.46.2', integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`, artifactSourceRevision: revision };
const directory = path.resolve('private-provenance-fixture');
const paths = { archive: path.join(directory, 'flujo-ai-3.46.2.tgz'), bundlePath: path.join(directory, 'bundles.jsonl') };
const repository = 'mario-andreschak/FLUJO';
const workflow = `${repository}/.github/workflows/publish-npm.yml`;
const workflowURI = `https://github.com/${workflow}@refs/heads/main`;
const predicateType = 'https://slsa.dev/provenance/v1';
const metadata = () => ({ name: 'flujo-ai', version: options.version, dist: { integrity: options.integrity,
  tarball: 'https://registry.npmjs.org/flujo-ai/-/flujo-ai-3.46.2.tgz',
  attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/flujo-ai@3.46.2', provenance: { predicateType } } } });
const bundle = () => ({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
  dsseEnvelope: { payload: 'unit-fixture-not-signed', signatures: [] }, verificationMaterial: {} });
const attestation = () => ({ attestations: [{ predicateType, bundle: bundle() }] });
const verified = () => [{ verificationResult: { signature: { certificate: {
  issuer: 'https://token.actions.githubusercontent.com', subjectAlternativeName: workflowURI,
  buildSignerURI: workflowURI, buildSignerDigest: revision,
  sourceRepositoryURI: `https://github.com/${repository}`, sourceRepositoryDigest: revision,
  sourceRepositoryRef: 'refs/heads/main', runnerEnvironment: 'github-hosted',
  buildConfigURI: workflowURI, buildConfigDigest: revision,
} }, verifiedTimestamps: [{ type: 'Tlog', uri: 'https://rekor.sigstore.dev', timestamp: '2026-10-03T00:00:00Z' }],
statement: { predicateType, subject: [{ name: 'pkg:npm/flujo-ai@3.46.2', digest: { sha512: Buffer.alloc(64, 7).toString('hex') } }],
  predicate: { deliberatelyUntrusted: 'The fixture is not a cryptographic proof.' } } } }];

function transport(values = [metadata(), attestation()]) {
  const requests = []; const captures = [];
  return { requests, captures, directory,
    capture: async (name, bytes) => { captures.push({ name, bytes: Buffer.from(bytes) }); },
    fetchResponse: async (url, settings) => {
      requests.push({ url, settings });
      const value = values.shift();
      return value instanceof Response ? value : new Response(JSON.stringify(value), { status: 200 });
    } };
}

test('fetches only fixed version and provenance endpoints and preserves complete bundles', async () => {
  const fixture = transport(); const result = await fetchNpmProvenance(options, fixture);
  assert.deepEqual(fixture.requests.map(item => item.url), [
    'https://registry.npmjs.org/flujo-ai/3.46.2', 'https://registry.npmjs.org/-/npm/v1/attestations/flujo-ai@3.46.2',
  ]);
  assert.ok(fixture.requests.every(item => item.settings.redirect === 'error' && item.settings.signal instanceof AbortSignal));
  assert.deepEqual(fixture.captures.map(item => item.name), ['npm-version.json', 'npm-attestations.json', 'npm-provenance-bundles.jsonl']);
  assert.deepEqual(JSON.parse(fixture.captures[2].bytes.toString().trim()), bundle());
  assert.equal(result.bundlePath, path.join(directory, 'npm-provenance-bundles.jsonl'));
  assert.equal(result.bundles, 1);
});

test('wrong metadata or attacker-selected endpoint stops before an attestation fetch', async () => {
  for (const change of [value => { value.name = 'other'; }, value => { value.version = '3.46.3'; },
    value => { value.dist.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`; },
    value => { value.dist.tarball = 'https://example.com/evil.tgz'; },
    value => { value.dist.attestations.url = 'https://example.com/evil.json'; },
    value => { value.dist.attestations.provenance.predicateType = 'other'; }]) {
    const value = metadata(); change(value); const fixture = transport([value]);
    await assert.rejects(fetchNpmProvenance(options, fixture), /metadata differs/);
    assert.equal(fixture.requests.length, 1); assert.equal(fixture.captures.length, 1);
  }
});

test('missing, publish-only and malformed provenance cannot become a verification bundle', async () => {
  for (const value of [null, {}, { attestations: [] }, { attestations: {} }, { attestations: [{ predicateType: 'publish', bundle: bundle() }] },
    { attestations: [{ predicateType, bundle: {} }] }]) {
    const fixture = transport([metadata(), value]);
    await assert.rejects(fetchNpmProvenance(options, fixture), /missing|malformed/);
    assert.equal(fixture.captures.length, 2);
  }
});

test('HTTP failure, invalid JSON and streamed over-limit bytes fail without retaining oversized content', async () => {
  for (const response of [new Response('missing', { status: 404 }), new Response('not json'),
    new Response(new Uint8Array(4 * 1024 * 1024 + 1))]) {
    const fixture = transport([response]);
    await assert.rejects(fetchNpmProvenance(options, fixture), /404|JSON|4 MiB/);
    assert.equal(fixture.requests.length, 1);
    assert.ok(fixture.captures.every(item => item.bytes.length <= 4 * 1024 * 1024));
  }
});

test('the verifier command pins SHA-512, official main workflow, source, signer and hosted runner', () => {
  const calls = [];
  const result = verifyNpmProvenance(options, paths, (command, args) => {
    calls.push({ command, args }); return JSON.stringify(verified());
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].command, 'gh');
  const args = calls[0].args;
  for (const [flag, value] of Object.entries({ '--bundle': paths.bundlePath, '--repo': repository, '--hostname': 'github.com',
    '--signer-workflow': workflow, '--source-ref': 'refs/heads/main', '--source-digest': revision,
    '--signer-digest': revision, '--digest-alg': 'sha512', '--predicate-type': predicateType,
    '--cert-oidc-issuer': 'https://token.actions.githubusercontent.com', '--format': 'json' })) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(args.includes('--deny-self-hosted-runners'));
  for (const bypass of ['--custom-trusted-root', '--no-public-good', '--cert-identity-regex']) assert.ok(!args.includes(bypass));
  assert.equal(result.result, 'passed-pinned-npm-provenance');
  assert.equal(result.attestations.length, 1);
  assert.equal(result.registryEcdsaSignaturesVerified, false);
  assert.equal(result.fullDistributionQualified, false); assert.equal(result.independentHumanAcceptance, false);
});

test('empty, malformed and partially policy-invalid verifier output never passes', () => {
  for (const output of ['', 'not json', '{}', '[]', '[{}]', JSON.stringify([...verified(), {}])]) {
    assert.throws(() => verifyNpmProvenance(options, paths, () => output));
  }
});

test('trusted certificate bindings, witnessed timestamp and exact subject are mandatory despite predicate claims', () => {
  const mutations = Object.keys(verified()[0].verificationResult.signature.certificate).map(key => result => {
    result.signature.certificate[key] = 'wrong';
  }).concat([
    result => { delete result.signature; }, result => { result.verifiedTimestamps = []; },
    result => { result.statement.predicateType = 'other'; }, result => { result.statement.subject = []; },
    result => { result.statement.subject[0].name = 'pkg:npm/flujo-ai@3.46.3'; },
    result => { result.statement.subject[0].digest.sha512 = 'f'.repeat(128); },
  ]);
  for (const mutate of mutations) {
    const value = verified(); mutate(value[0].verificationResult);
    value[0].verificationResult.statement.predicate = { repository, revision, workflowURI, runnerEnvironment: 'github-hosted' };
    assert.throws(() => verifyNpmProvenance(options, paths, () => JSON.stringify(value)), /policy/);
  }
});

test('cryptographic verifier failure is propagated', () => {
  assert.throws(() => verifyNpmProvenance(options, paths, () => { throw new Error('signature verification failed'); }), /signature verification failed/);
});

test('unsafe pins and relative paths are rejected before network or verifier commands', async () => {
  for (const value of [{ ...options, version: '../3.46.2' }, { ...options, integrity: 'sha512-Zm9v' },
    { ...options, artifactSourceRevision: 'main' }]) {
    const fixture = transport(); await assert.rejects(fetchNpmProvenance(value, fixture), /exact/);
    assert.equal(fixture.requests.length, 0);
    assert.throws(() => verifyNpmProvenance(value, paths, () => assert.fail('Unexpected command')), /exact/);
  }
  assert.throws(() => verifyNpmProvenance(options, { ...paths, archive: './artifact' }, () => assert.fail('Unexpected command')), /Absolute/);
});
