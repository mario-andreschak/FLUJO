import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { PUBLIC_PACKAGES } from './release-packages.mjs';
import { writeReleaseEvidence } from './release-evidence.mjs';
import { REQUIRED_CHECK_NAMES } from './verification-contract.mjs';
import { parseUpgradeOptions, assertCandidateScans, assertCandidateScanReport, qualifyCandidate } from './maintainer-installed-upgrade.mjs';

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
function sarif(language = 'javascript-typescript') {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' }, extensions: [{ name: `codeql/${language}-queries`,
    rules: Array.from({ length: 23 }, (_, index) => ({ id: language === 'javascript-typescript' && index === 0 ? 'js/http-to-file-access' : `${language}/fixture-${index}` })) }] },
  automationDetails: { id: `/language:${language}/` }, results: [],
  versionControlProvenance: [{ repositoryUri: 'https://github.com/mario-andreschak/FLUJO', revisionId: source, branch: 'refs/heads/main' }],
  properties: { codeqlConfigSummary: { queries: [{ type: 'builtinSuite', uses: 'security-extended' }] } } }] };
}
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
  const calls = []; let signerCalled = false; let reportRead = false;
  const run = (command, argv) => {
    calls.push({ command, argv }); assert.equal(command, 'gh');
    if (argv[0] === 'attestation') { signerCalled = true; return 'mock signer result: unit fixture only'; }
    if (argv[0] === 'run') return JSON.stringify((signerCalled && changes.runsAfterSigner) || changes.runs || [{ databaseId: 7, workflowDatabaseId: 9,
      headSha: source, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success' }]);
    const endpoint = argv.find(value => value.startsWith('repos/'));
    if (endpoint.endsWith('actions/workflows/verify.yml')) return JSON.stringify({ id: 9, path: '.github/workflows/verify.yml', state: 'active' });
    if (/\/code-scanning\/analyses\/\d+$/.test(endpoint)) {
      reportRead = true;
      assert.ok(argv.includes('-H')); assert.ok(argv.includes('Accept: application/sarif+json'));
      const id = Number(endpoint.split('/').at(-1)); const language = id % 2 ? 'javascript-typescript' : 'actions';
      return JSON.stringify((signerCalled && changes.sarifAfterSigner) || changes.sarif || sarif(language));
    }
    if (endpoint.includes('/code-scanning/analyses')) {
      if (reportRead && changes.analysesDuringSarif) return JSON.stringify([changes.analysesDuringSarif]);
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

test('a full SARIF report must bind main source, suite, rule/result counts and category without a PR diff range', () => {
  const analysis = assertCandidateScans(analyses(), [], source)[0];
  assert.equal(assertCandidateScanReport(sarif(), analysis).diffInformed, false);
  for (const alter of [value => { value.version = 'unexpected'; }, value => { value.runs = []; },
    value => { value.runs[0].tool.extensions.push({ name: 'codeql-action/pr-diff-range' }); },
    value => { value.runs[0].properties.incrementalMode = 'diff-informed'; },
    value => { value.runs[0].automationDetails.id = '/language:actions/'; },
    value => { value.runs[0].versionControlProvenance[0].branch = 'refs/pull/731/merge'; },
    value => { value.runs[0].versionControlProvenance[0].revisionId = 'b'.repeat(40); },
    value => { value.runs[0].versionControlProvenance[0].repositoryUri = 'https://github.com/other/repository'; },
    value => { value.runs[0].versionControlProvenance = []; },
    value => { value.runs[0].properties.codeqlConfigSummary.queries = []; },
    value => { value.runs[0].tool.extensions[0].rules.pop(); },
    value => { value.runs[0].tool.extensions[0].rules[0].id = 'unrelated/query'; },
    value => { value.runs[0].tool.extensions[0].rules[1].id = 'js/http-to-file-access'; },
    value => { value.runs[0].tool.extensions[0].rules = {}; },
    value => { value.runs[0].results = [{}]; }]) {
    const changed = sarif(); alter(changed); assert.throws(() => assertCandidateScanReport(changed, analysis), /Candidate CodeQL/);
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
    await assert.rejects(qualifyCandidate(bundle(), fixture.run), /missing|warned|paginated candidate scan/);
    assert.equal(fixture.calls.filter(call => call.argv[0] === 'attestation').length, PUBLIC_PACKAGES.length + 3);
  }
});

test('signer scan refresh retains the newest valid analyses in admission evidence', async () => {
  const latest = analyses().map(item => ({ ...item, id: item.id + 100 }));
  const fixture = commands({ analysesAfterSigner: latest });
  const result = await qualifyCandidate(bundle(), fixture.run);
  assert.deepEqual(result.scans.map(item => item.id), latest.map(item => item.id));
  const reads = fixture.calls.filter(call => call.argv[1]?.includes('/code-scanning/analyses?'));
  assert.equal(reads.length, 4);
  for (const { argv } of reads) {
    assert.ok(argv[1].includes('ref=refs%2Fheads%2Fmain'));
    assert.ok(argv.includes('--paginate')); assert.ok(argv.includes('--slurp'));
  }
  const reportReads = fixture.calls.filter(call => call.argv.at(-1)?.match(/\/code-scanning\/analyses\/\d+$/));
  assert.deepEqual(reportReads.map(call => Number(call.argv.at(-1).split('/').at(-1))), [101, 102, 201, 202]);
  assert.ok(result.scans.every(item => /^[a-f0-9]{64}$/.test(item.report.rawSha256) && item.report.rawBytes > 0));
});

test('green main metadata cannot use a diff-informed SARIF report before signing acceptance', async () => {
  const partial = sarif(); partial.runs[0].tool.extensions.push({ name: 'codeql-action/pr-diff-range' });
  const fixture = commands({ sarif: partial });
  await assert.rejects(qualifyCandidate(bundle(), fixture.run), /diff-informed/);
  assert.equal(fixture.calls.filter(call => call.argv[0] === 'attestation').length, 0);
});

test('a partial SARIF appearing during signer checks invalidates prior full scan evidence', async () => {
  const partial = sarif(); partial.runs[0].properties.incrementalMode = 'diff-informed';
  const fixture = commands({ sarifAfterSigner: partial });
  await assert.rejects(qualifyCandidate(bundle(), fixture.run), /diff-informed/);
  assert.equal(fixture.calls.filter(call => call.argv[0] === 'attestation').length, PUBLIC_PACKAGES.length + 3);
});

test('an analysis replacement during SARIF reads requires fresh coherent admission', async () => {
  const fixture = commands({ analysesDuringSarif: analyses().map(item => ({ ...item, id: item.id + 100 })) });
  await assert.rejects(qualifyCandidate(bundle(), fixture.run), /changed while inspecting SARIF/);
  assert.equal(fixture.calls.filter(call => call.argv[0] === 'attestation').length, 0);
});
