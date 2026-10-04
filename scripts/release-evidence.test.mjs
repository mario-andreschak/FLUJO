import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PUBLIC_PACKAGES } from './release-packages.mjs';
import { EVIDENCE_FILE, SBOM_FILE, CHECKSUM_FILE, prepareReleaseEvidence, writeReleaseEvidence, validateReleaseEvidence, verifyReleaseAttestations } from './release-evidence.mjs';

const sha = 'a'.repeat(40);
const version = '3.46.2';
const sourceLock = Buffer.from(JSON.stringify({ name: 'flujo-ai', version, lockfileVersion: 3, packages: { '': { name: 'flujo-ai', version }, 'node_modules/synthetic': { version: '1.0.0', dev: true } } }));
const sbom = { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  metadata: { component: { type: 'application', name: 'flujo-ai', version } }, components: [{ type: 'library', name: 'synthetic', version: '1.0.0' }] };
const runtime = { node: 'v22.13.1', npm: '11.21.0', platform: 'linux', architecture: 'x64' };

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flujo-release-evidence-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const packages = PUBLIC_PACKAGES.map((name, index) => {
    const filename = `synthetic-${index}.tgz`;
    const bytes = Buffer.from(`synthetic package payload ${name}`);
    writeFileSync(path.join(directory, filename), bytes);
    return { name, filename, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  });
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, revision: sha, version, packages }));
  return { directory, sha, version, sourceLock, sbom, runtime };
}

test('metadata binds every original tarball, source lock and scoped SBOM without exporting credentials', (t) => {
  const f = fixture(t);
  const evidence = writeReleaseEvidence({ ...f, env: { NPM_TOKEN: 'private-npm-value', GITHUB_TOKEN: 'private-github-value', OPENAI_API_KEY: 'private-provider-value' } });
  assert.equal(evidence.artifacts.length, PUBLIC_PACKAGES.length);
  assert.equal(evidence.sourceLock.sha256, createHash('sha256').update(sourceLock).digest('hex'));
  assert.match(evidence.sbom.scope, /consumer resolution.*excluded/);
  const serialized = readFileSync(path.join(f.directory, EVIDENCE_FILE), 'utf8');
  assert.doesNotMatch(serialized, /private-/);
  assert.equal(readFileSync(path.join(f.directory, CHECKSUM_FILE), 'utf8').trim().split('\n').length, PUBLIC_PACKAGES.length + 3);
  assert.deepEqual(validateReleaseEvidence(f), evidence);
});

test('evidence generation rejects credential-bearing lockfile URLs before export', (t) => {
  const f = fixture(t);
  const locked = JSON.parse(sourceLock);
  locked.packages['node_modules/synthetic'].resolved = 'https://private-user:private-password@registry.example/synthetic.tgz';
  assert.throws(() => writeReleaseEvidence({ ...f, sourceLock: Buffer.from(JSON.stringify(locked)) }), /registry credentials/);
  assert.equal(existsSync(path.join(f.directory, EVIDENCE_FILE)), false);
});

test('npm root display names may differ while the canonical package URL must match', (t) => {
  const f = fixture(t);
  const displayed = structuredClone(sbom);
  displayed.metadata.component.name = 'FLUJO';
  displayed.metadata.component.purl = `pkg:npm/flujo-ai@${version}`;
  writeReleaseEvidence({ ...f, sbom: displayed });
  displayed.metadata.component.purl = 'pkg:npm/attacker@3.46.2';
  assert.throws(() => writeReleaseEvidence({ ...f, sbom: displayed }), /CycloneDX inventory/);
});

test('workflow metadata cannot substitute another revision, ref or workflow', (t) => {
  const f = fixture(t);
  const env = { GITHUB_SHA: sha, GITHUB_REPOSITORY: 'mario-andreschak/FLUJO', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'mario-andreschak/FLUJO/.github/workflows/publish-npm.yml@refs/heads/main', GITHUB_WORKFLOW_SHA: sha };
  writeReleaseEvidence({ ...f, env });
  for (const change of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_WORKFLOW_REF: 'attacker/repo/workflow.yml' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }]) {
    assert.throws(() => writeReleaseEvidence({ ...f, env: { ...env, ...change } }), /workflow identity/);
  }
});

for (const file of ['synthetic-0.tgz', 'manifest.json', EVIDENCE_FILE, SBOM_FILE, CHECKSUM_FILE]) {
  test(`evidence verification rejects changed or missing ${file}`, (t) => {
    const f = fixture(t);
    writeReleaseEvidence(f);
    writeFileSync(path.join(f.directory, file), 'tampered');
    assert.throws(() => validateReleaseEvidence(f));
    rmSync(path.join(f.directory, file));
    assert.throws(() => validateReleaseEvidence(f));
  });
}

test('source-lock identity and requested release cannot be reused for another source', (t) => {
  const f = fixture(t);
  writeReleaseEvidence(f);
  assert.throws(() => validateReleaseEvidence({ ...f, sha: 'b'.repeat(40) }));
  assert.throws(() => validateReleaseEvidence({ ...f, version: '3.46.3' }));
  assert.throws(() => validateReleaseEvidence({ ...f, sourceLock: Buffer.from(`${sourceLock}\n`) }), /expected source/);
});

test('SBOM generation is offline and lockfile-only, with no lifecycle scripts', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.directory, 'package-lock.json'), sourceLock);
  const calls = [];
  const evidence = prepareReleaseEvidence({ ...f, sourceRoot: f.directory, env: {}, run: (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'npm');
    return args[0] === 'sbom' ? JSON.stringify(sbom) : '11.21.0';
  } });
  assert.equal(evidence.artifacts.length, 5);
  assert.equal(calls[0].options.cwd, f.directory);
  for (const flag of ['--package-lock-only', '--include=dev', '--offline', '--ignore-scripts']) assert.ok(calls[0].args.includes(flag));
});

test('cryptographic verification binds all subjects to the official hosted exact-SHA workflow', (t) => {
  const f = fixture(t);
  writeReleaseEvidence(f);
  const calls = [];
  verifyReleaseAttestations({ ...f, run: (command, args) => {
    calls.push(args);
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
    assert.equal(args[args.indexOf('--repo') + 1], 'mario-andreschak/FLUJO');
    assert.equal(args[args.indexOf('--predicate-type') + 1], 'https://slsa.dev/provenance/v1');
    assert.equal(args[args.indexOf('--source-digest') + 1], sha);
    assert.equal(args[args.indexOf('--signer-digest') + 1], sha);
    assert.equal(args[args.indexOf('--source-ref') + 1], 'refs/heads/main');
    assert.equal(args[args.indexOf('--cert-identity') + 1], 'https://github.com/mario-andreschak/FLUJO/.github/workflows/publish-npm.yml@refs/heads/main');
    assert.equal(args[args.indexOf('--cert-oidc-issuer') + 1], 'https://token.actions.githubusercontent.com');
    assert.equal(args.includes('--signer-workflow'), false);
    assert.equal(args.includes('--cert-identity-regex'), false);
    assert.ok(args.includes('--deny-self-hosted-runners'));
  } });
  assert.equal(calls.length, PUBLIC_PACKAGES.length + 3);
  let attempts = 0;
  assert.throws(() => verifyReleaseAttestations({ ...f, run: () => { attempts++; throw new Error('invalid signature'); } }), /invalid signature/);
  assert.equal(attempts, 1);
});
