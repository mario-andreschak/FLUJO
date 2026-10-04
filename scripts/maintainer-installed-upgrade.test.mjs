import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { PUBLIC_PACKAGES } from './release-packages.mjs';
import { writeReleaseEvidence } from './release-evidence.mjs';
import { REQUIRED_CHECK_NAMES } from './verification-contract.mjs';
import { parseUpgradeOptions, assertCandidateScans, qualifyCandidate } from './maintainer-installed-upgrade.mjs';

const source = 'a'.repeat(40);
const directories = [];
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const options = (directory = path.join(os.tmpdir(), 'candidate-evidence')) => ({
  baseline: { version: '3.46.2', integrity: integrity('baseline'), artifactSourceRevision: 'b'.repeat(40), npmCli: undefined },
  candidate: { version: '3.46.3', integrity: integrity('candidate'), artifactSourceRevision: source, npmCli: undefined },
  candidateEvidence: directory,
});
const args = value => ['baseline', 'candidate'].flatMap(role => [
  `--${role}-version=${value[role].version}`, `--${role}-integrity=${value[role].integrity}`,
  `--${role}-source-revision=${value[role].artifactSourceRevision}`,
]).concat(`--candidate-evidence=${value.candidateEvidence}`);
const analyses = () => ['javascript-typescript', 'actions'].map((language, index) => ({ id: 101 + index,
  commit_sha: source, ref: 'refs/heads/main', category: `/language:${language}`, results_count: 0,
  rules_count: 23, error: '', warning: '', tool: { name: 'CodeQL' } }));
after(() => {
  for (const directory of directories) {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('flujo-upgrade-contract-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

function bundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flujo-upgrade-contract-test-')); directories.push(directory);
  const packages = PUBLIC_PACKAGES.map((name, index) => {
    const filename = `fixture-${index}.tgz`; const bytes = Buffer.from(name === 'flujo-ai' ? 'candidate' : name);
    writeFileSync(path.join(directory, filename), bytes);
    return { name, filename, integrity: integrity(bytes) };
  });
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, revision: source, version: '3.46.3', packages }));
  writeReleaseEvidence({ directory, sha: source, version: '3.46.3',
    sourceLock: Buffer.from(JSON.stringify({ name: 'flujo-ai', version: '3.46.3', packages: { '': { version: '3.46.3' } } })),
    sbom: { bomFormat: 'CycloneDX', specVersion: '1.6', metadata: { component: { name: 'flujo-ai', version: '3.46.3' } }, components: [{ name: 'fixture' }] },
    runtime: { node: process.version, npm: '11.0.0', platform: process.platform, architecture: process.arch } });
  return options(directory);
}
function commands(changes = {}) {
  const calls = []; let signerCalled = false;
  const run = (command, argv) => {
    calls.push({ command, argv }); assert.equal(command, 'gh');
    if (argv[0] === 'attestation') { signerCalled = true; return 'mock signer result: unit fixture only'; }
    if (argv[0] === 'run') return JSON.stringify((signerCalled && changes.runsAfterSigner) || changes.runs || [{ databaseId: 7, workflowDatabaseId: 9,
      headSha: source, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success' }]);
    const endpoint = argv[1];
    if (endpoint.endsWith('actions/workflows/verify.yml')) return JSON.stringify({ id: 9, path: '.github/workflows/verify.yml', state: 'active' });
    if (endpoint.includes('/code-scanning/analyses')) {
      const entries = signerCalled && Object.hasOwn(changes, 'analysesAfterSigner')
        ? changes.analysesAfterSigner : changes.analyses ?? analyses();
      return JSON.stringify([entries]);
    }
    if (endpoint.includes('/code-scanning/alerts')) return JSON.stringify([(signerCalled && changes.alertsAfterSigner) || changes.alerts || []]);
    if (endpoint.includes('/attempts/')) return JSON.stringify([{ jobs: changes.jobs ?? REQUIRED_CHECK_NAMES.map(name => ({ name, status: 'completed', conclusion: 'success' })) }]);
    if (endpoint.endsWith('/actions/runs/7')) return JSON.stringify({ id: 7, workflow_id: 9, head_sha: source,
      head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, path: '.github/workflows/verify.yml', ...changes.attempt });
    throw new Error(`Unexpected fixture command ${endpoint}`);
  };
  return { run, calls };
}

test('upgrade pins require complete canonical increasing versions and an absolute release directory', () => {
  assert.deepEqual(parseUpgradeOptions(args(options())), options());
  for (const version of ['3.46.2', '3.45.99', '03.47.0', '9007199254740992.0.0']) {
    const value = options(); value.candidate.version = version;
    assert.throws(() => parseUpgradeOptions(args(value)));
  }
  assert.throws(() => parseUpgradeOptions(args(options()).concat('--candidate-version=3.47.0')));
  assert.throws(() => parseUpgradeOptions(args({ ...options(), candidateEvidence: './local' })));
  assert.throws(() => parseUpgradeOptions(args(options()).slice(1)));
});

test('candidate scan admission rejects missing, wrong-source, warned and still-open evidence', () => {
  assert.equal(assertCandidateScans(analyses(), [], source).length, 2);
  assert.throws(() => assertCandidateScans(analyses(), [{ number: 267 }], source), /open/);
  assert.throws(() => assertCandidateScans([], [], source), /missing/);
  for (const change of [{ commit_sha: 'b'.repeat(40) }, { ref: 'refs/pull/1/merge' }, { error: 'failed extraction' }, { warning: 'partial' }, { rules_count: 0 },
    { id: null }, { results_count: null }, { error: undefined }, { warning: undefined }, { tool: { name: 'unrelated' } }]) {
    const changed = analyses(); changed[0] = { ...changed[0], ...change };
    assert.throws(() => assertCandidateScans(changed, [], source), /missing|warned/);
  }
});

test('distribution/pin mismatch is rejected before any external command', async () => {
  const value = bundle(); value.candidate.integrity = integrity('wrong'); const fixture = commands();
  await assert.rejects(qualifyCandidate(value, fixture.run), /pin differs/);
  assert.equal(fixture.calls.length, 0);
});

test('canonical source and signature command contract is preserved by the candidate gate', async () => {
  const fixture = commands(); const value = bundle();
  const result = await qualifyCandidate(value, fixture.run);
  assert.equal(result.verificationRunId, 7); assert.equal(result.acceptedAttempt.attempt, 1);
  assert.equal(result.independentHumanAcceptance, false);
  const signatures = fixture.calls.filter(call => call.argv[0] === 'attestation');
  assert.equal(signatures.length, PUBLIC_PACKAGES.length + 3);
  for (const { argv } of signatures) {
    assert.ok(argv.includes('--deny-self-hosted-runners'));
    assert.equal(argv[argv.indexOf('--source-digest') + 1], source);
    assert.equal(argv[argv.indexOf('--signer-digest') + 1], source);
    assert.equal(argv[argv.indexOf('--source-ref') + 1], 'refs/heads/main');
  }
});

test('failed, unfinished, wrong-branch and incomplete main verification never reach signer acceptance', async () => {
  for (const changes of [{ runs: [] }, { runs: [{ databaseId: 7, workflowDatabaseId: 9, headSha: source,
    headBranch: 'main', event: 'push', status: 'completed', conclusion: 'failure' }] },
  { runs: [{ databaseId: 7, workflowDatabaseId: 9, headSha: source, headBranch: 'main', event: 'push', status: 'in_progress', conclusion: '' }] },
  { attempt: { head_branch: 'codex/topic' } }, { jobs: [] }]) {
    const fixture = commands(changes);
    await assert.rejects(qualifyCandidate(bundle(), fixture.run));
    assert.equal(fixture.calls.filter(call => call.argv[0] === 'attestation').length, 0);
  }
});

test('open CodeQL findings prevent candidate signing acceptance even when every job is green', async () => {
  const fixture = commands({ alerts: [{ number: 267 }] });
  await assert.rejects(qualifyCandidate(bundle(), fixture.run), /open main CodeQL/);
  assert.equal(fixture.calls.filter(call => call.argv[0] === 'attestation').length, 0);
});

test('structured callers cannot bypass the increasing-version or pin parser', async () => {
  const value = bundle(); value.baseline.version = value.candidate.version; const fixture = commands();
  await assert.rejects(qualifyCandidate(value, fixture.run), /greater candidate/);
  assert.equal(fixture.calls.length, 0);
});

test('new failed verification or open alerts during signer checks invalidate prior green admission', async () => {
  for (const changes of [{ runsAfterSigner: [{ databaseId: 7, workflowDatabaseId: 9, headSha: source,
    headBranch: 'main', event: 'push', status: 'completed', conclusion: 'failure' }] }, { alertsAfterSigner: [{ number: 999 }] }]) {
    const fixture = commands(changes);
    await assert.rejects(qualifyCandidate(bundle(), fixture.run), /concluded failure|open main CodeQL/);
    assert.ok(fixture.calls.some(call => call.argv[0] === 'attestation'));
  }
});

test('signer scan refresh rejects new incomplete source analyses before admission', async () => {
  const warned = analyses().concat({ ...analyses()[0], id: 201, warning: 'partial extraction' });
  const failed = analyses().concat({ ...analyses()[1], id: 202, error: 'failed extraction' });
  const wrongSource = analyses().map(item => ({ ...item, commit_sha: 'c'.repeat(40) }));
  for (const entries of [[], null, analyses().slice(0, 1), warned, failed, wrongSource]) {
    const fixture = commands({ analysesAfterSigner: entries });
    await assert.rejects(qualifyCandidate(bundle(), fixture.run), /missing|warned|final candidate analyses/);
    assert.equal(fixture.calls.filter(call => call.argv[0] === 'attestation').length, PUBLIC_PACKAGES.length + 3);
  }
});

test('signer scan refresh retains the newest valid analyses in admission evidence', async () => {
  const latest = analyses().map(item => ({ ...item, id: item.id + 100 }));
  const fixture = commands({ analysesAfterSigner: latest });
  const result = await qualifyCandidate(bundle(), fixture.run);
  assert.deepEqual(result.scans.map(item => item.id), latest.map(item => item.id));
  const reads = fixture.calls.filter(call => call.argv[1]?.includes('/code-scanning/analyses'));
  assert.equal(reads.length, 2);
  for (const { argv } of reads) {
    assert.ok(argv[1].includes('ref=refs%2Fheads%2Fmain'));
    assert.ok(argv.includes('--paginate')); assert.ok(argv.includes('--slurp'));
  }
});
