import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateScorecard, validateShape } from './validate-scorecard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(join(root, 'docs/audits/scorecard-563/scorecard.json'), 'utf8'));
function entry(ledger, collection, id) {
  const found = ledger[collection].find(item => item.id === id);
  assert.ok(found, `Fixture entry missing: ${collection}/${id}`);
  return found;
}
function validate(edit = () => {}) {
  const ledger = structuredClone(baseline);
  edit(ledger);
  return validateScorecard(ledger, { root });
}
function rejects(edit, pattern) {
  const result = validate(edit);
  assert.ok(result.errors.some(error => pattern.test(error)), result.errors.join('\n'));
}

test('dated baseline is structurally valid, checksummed and visibly incomplete', () => {
  const result = validate();
  assert.deepEqual(result.errors, []);
  assert.ok(result.blockers.includes('All nine independent A- or better reassessments pending'));
  assert.ok(result.blockers.some(blocker => blocker.includes('shared-profile')));
});
test('unknown fields and future versions fail closed', () => {
  rejects(l => { l.selfAwardedGrade = 'A'; }, /unknown field/);
  rejects(l => { l.schemaVersion = 2; }, /unexpected constant/);
  assert.throws(() => validateShape('x', { format: 'date' }), /Unsupported schema keyword/);
});
test('missing/duplicated scorecard rows and silent profile reduction are rejected', () => {
  rejects(l => { l.rubric.pop(); }, /too few|required complete set/);
  rejects(l => { l.rubric[1] = structuredClone(l.rubric[0]); }, /duplicate ID|required complete set/);
  rejects(l => { l.profiles.pop(); }, /too few|required complete set/);
  rejects(l => { l.scope.profileReduction = 'local-only'; }, /unexpected constant/);
  rejects(l => { l.rubric[4].originalGrade = 'A'; }, /original dimension\/grade changed/);
});
test('references and all existing issue reconciliation rows must resolve', () => {
  rejects(l => { entry(l, 'claims', 'product-fit-a-minus').evidenceIds = ['invented-pass']; }, /unknown evidence ID/);
  rejects(l => { l.issueReconciliation[0].issue = 999; }, /required complete set/);
  rejects(l => { entry(l, 'gates', 'rubric-agreement').evidenceIds = ['baseline-2026-10-03', 'baseline-2026-10-03']; }, /duplicate references/);
});
test('existing Persona thresholds cannot be weakened and historical failure cannot disappear', () => {
  rejects(l => { l.budgets.find(b => b.id === 'persona-append-p95').limit = 170; }, /existing numeric contract changed/);
  rejects(l => { l.budgets.find(b => b.id === 'persona-rss-growth').operator = '<'; }, /existing numeric contract changed/);
  rejects(l => { l.evidence.find(e => e.id === 'persona-september16-failure').result = 'passed'; }, /contradicts measured|Historical/);
  rejects(l => { l.evidence = l.evidence.filter(e => e.id !== 'persona-september16-failure'); }, /Historical/);
});
test('raw payload tampering, absent checksums and outside paths are rejected', () => {
  rejects(l => { entry(l, 'evidence', 'baseline-2026-10-03').raw[0].sha256 = '0'.repeat(64); }, /checksum mismatch/);
  rejects(l => { entry(l, 'evidence', 'baseline-2026-10-03').raw[0].sha256 = null; }, /missing SHA-256|needs a retained/);
  rejects(l => { entry(l, 'evidence', 'baseline-2026-10-03').raw[0].location = '../outside.json'; }, /escapes repository/);
  rejects(l => { entry(l, 'evidence', 'baseline-2026-10-03').raw[0].location = 'C:/private/file.json'; }, /repository-relative/);
});
test('realpath containment prevents symlink escape without reading foreign content', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'flujo-scorecard-'));
  const repo = join(fixture, 'repo');
  const outside = join(fixture, 'outside');
  // Junctions avoid elevated symlink privileges on Windows.
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(join(outside, 'witness.json'), '{}');
  symlinkSync(outside, join(repo, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const ledger = structuredClone(baseline);
    entry(ledger, 'evidence', 'baseline-2026-10-03').raw[0].location = 'link/witness.json';
    const result = validateScorecard(ledger, { root: repo });
    assert.ok(result.errors.some(e => e.includes('symlink escapes repository')));
  } finally {
    const cleanupPath = realpathSync(fixture);
    assert.equal(realpathSync(dirname(cleanupPath)), realpathSync(tmpdir()));
    assert.ok(basename(cleanupPath).startsWith('flujo-scorecard-'));
    rmSync(cleanupPath, { recursive: true, force: true });
  }
});
test('reported CI/source metadata cannot promote a shipped-artifact claim or gate', () => {
  rejects(l => {
    entry(l, 'claims', 'product-fit-a-minus').status = 'release-supported';
    entry(l, 'claims', 'product-fit-a-minus').evidenceIds = ['verify-main-reported'];
  }, /passing checksummed|installed-artifact acceptance/);
  rejects(l => { entry(l, 'gates', 'release-acceptance').status = 'passed'; entry(l, 'gates', 'release-acceptance').evidenceIds = ['baseline-2026-10-03']; }, /wrong evidence kind/);
  rejects(l => { entry(l, 'artifacts', 'npm-3.46.2').provenance = 'verified-content'; }, /verified content needs|no matching retained/);
});
test('live/human evidence cannot use simulation or unbound release identity', () => {
  rejects(l => { entry(l, 'evidence', 'persona-later-reported').kind = 'live-provider'; }, /actual elapsed window/);
  rejects(l => { entry(l, 'evidence', 'baseline-2026-10-03').kind = 'human-study'; }, /actual elapsed window/);
  rejects(l => { entry(l, 'evidence', 'baseline-2026-10-03').kind = 'installed-artifact'; }, /matching release artifact/);
});
test('measured results reject false pass, zero denominator and postdeclared budgets', () => {
  rejects(l => { entry(l, 'evidence', 'persona-september16-failure').metrics[0].denominator = 0; }, /below minimum/);
  rejects(l => {
    const e = entry(l, 'evidence', 'baseline-2026-10-03');
    e.budgetIds = ['novice-success'];
    e.metrics = [{ budgetId: 'novice-success', value: 8, denominator: 10, numerator: null }];
  }, /proposed budget cannot establish acceptance/);
  rejects(l => {
    const e = entry(l, 'evidence', 'baseline-2026-10-03');
    e.budgetIds = ['persona-peak-rss'];
    e.metrics = [{ budgetId: 'persona-peak-rss', value: 1, denominator: 28, numerator: null }];
    e.window = { kind: 'elapsed', start: '2026-10-02T00:00:00Z', end: '2026-10-02T01:00:00Z', simulatedDays: null };
  }, /budget declared after measurement/);
});
test('mixed revisions and source-only evidence cannot support one accepted release', () => {
  rejects(l => {
    const newer = structuredClone(entry(l, 'evidence', 'baseline-2026-10-03'));
    newer.id = 'different-revision';
    newer.sourceSha = '1'.repeat(40);
    l.evidence.push(newer);
    const c = entry(l, 'claims', 'product-fit-a-minus');
    c.status = 'release-supported';
    c.requiredKinds = ['baseline-observation'];
    c.evidenceIds = ['baseline-2026-10-03', 'different-revision'];
  }, /mixed revisions|source checks cannot substitute/);
});
test('independent reassessment cannot be inferred from implementation or self review', () => {
  rejects(l => { l.assessment.status = 'completed'; }, /independent reviewer|assessment grades/);
  rejects(l => { l.agreements.maintainer.identity = 'same-person'; l.agreements.independentReviewer.identity = 'same-person'; }, /cannot be the accepting maintainer/);
});
test('accepted claims require measured budgets and explicit profile coverage', () => {
  rejects(l => {
    const c = l.claims.find(c => c.dimensionId === 'maturity');
    c.status = 'source-supported';
    c.requiredKinds = ['baseline-observation'];
    c.budgetIds = ['persona-peak-rss'];
    c.evidenceIds = ['baseline-2026-10-03'];
  }, /missing passing measurement/);
  rejects(l => {
    const c = entry(l, 'claims', 'product-fit-a-minus');
    c.status = 'source-supported';
    c.requiredKinds = ['baseline-observation'];
    c.evidenceIds = ['baseline-2026-10-03'];
    entry(l, 'evidence', 'baseline-2026-10-03').profileIds = ['persistent-worker'];
  }, /does not cover claimed profile/);
  rejects(l => { l.gates = l.gates.filter(g => g.id !== 'shared-profile'); }, /Required gate omitted/);
});
// Synthetic in-memory records test the contract; they are never published as human evidence.
function observedBudget(ledger, budgetId, value, denominator) {
  const agreement = structuredClone(entry(ledger, 'evidence', 'baseline-2026-10-03'));
  Object.assign(agreement, { id: 'synthetic-agreement', kind: 'external-agreement', artifactId: null, observedAt: '2026-10-04T00:00:00Z', scope: 'Synthetic validator fixture only.' });
  ledger.evidence.push(agreement);
  const budget = ledger.budgets.find(b => b.id === budgetId);
  budget.status = 'agreed';
  budget.agreementEvidenceIds = [agreement.id];
  const study = structuredClone(entry(ledger, 'evidence', 'baseline-2026-10-03'));
  Object.assign(study, { id: 'synthetic-study', kind: budgetId.startsWith('live-') ? 'live-provider' : 'human-study', artifactId: null, observedAt: '2026-12-01T00:00:00Z', scope: 'Synthetic validator fixture only.', budgetIds: [budgetId], metrics: [{ budgetId, value, denominator, numerator: null }], window: { kind: 'elapsed', start: '2026-10-05T00:00:00Z', end: '2026-11-30T00:00:00Z', simulatedDays: null } });
  ledger.evidence.push(study);
  return { budget, agreement, study };
}
test('a complete predeclared eight-week observation validates without satisfying closure', () => {
  const result = validate(l => { observedBudget(l, 'pilot-users', 10, 10); });
  assert.deepEqual(result.errors, []);
  assert.ok(result.blockers.length > 0);
});
test('elapsed windows and cohort denominators cannot be silently reduced', () => {
  rejects(l => { observedBudget(l, 'pilot-users', 10, 10).study.window.end = '2026-10-05T01:00:00Z'; }, /window too short/);
  rejects(l => { observedBudget(l, 'novice-success', 8, 8); }, /denominator below declared minimum/);
  rejects(l => { observedBudget(l, 'human-contributors', 3, 3); }, /window too short/);
  rejects(l => { l.budgets.find(b => b.id === 'pilot-users').observation.minimumSeconds = 3600; }, /published human observation contract weakened/);
  rejects(l => { l.budgets.find(b => b.id === 'persona-peak-rss').observation.minimumSimulatedDays = 27; }, /full 28-day workload changed/);
});
test('agreement must precede measurement, not just a claimed declaration timestamp', () => {
  rejects(l => { observedBudget(l, 'pilot-users', 10, 10).agreement.observedAt = '2026-10-05T00:00:01Z'; }, /agreement occurred after measurement/);
});
test('live duration and success ratios reconcile with actual windows and integer counts', () => {
  rejects(l => { observedBudget(l, 'live-seven-days', 604800, 100).study.window.end = '2026-10-05T01:00:00Z'; }, /duration metric exceeds actual elapsed|window too short/);
  rejects(l => { observedBudget(l, 'live-success-rate', 0.99, 100); }, /ratio does not reconcile/);
  rejects(l => { observedBudget(l, 'live-success-rate', 0.99, 100).study.metrics[0].numerator = 98; }, /ratio does not reconcile/);
  const result = validate(l => { observedBudget(l, 'live-success-rate', 0.99, 100).study.metrics[0].numerator = 99; });
  assert.deepEqual(result.errors, []);
  assert.ok(result.blockers.length > 0);
});
function artifactReportFixture(edit = () => {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'flujo-scorecard-'));
  const ledger = structuredClone(baseline);
  try {
    for (const evidence of ledger.evidence) {
      for (const raw of evidence.raw.filter(raw => raw.verification === 'local')) {
        const target = join(fixture, raw.location);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(join(root, raw.location)));
      }
    }
    const payloadSha256 = createHash('sha256').update('synthetic package bytes, not an installed app').digest('hex');
    const artifact = { id: 'synthetic-npm', kind: 'npm', identity: 'Synthetic schema fixture only', sourceSha: ledger.scope.sourceBaselineSha, provenance: 'verified-content', payloadSha256, metadataEvidenceIds: [] };
    ledger.artifacts.push(artifact);
    const evidence = structuredClone(entry(ledger, 'evidence', 'baseline-2026-10-03'));
    const location = 'artifact-proof-fixture.json';
    Object.assign(evidence, { id: 'synthetic-installed', kind: 'installed-artifact', artifactId: artifact.id, sourceSha: artifact.sourceSha, profileIds: ['local-owner'], artifactProof: { location }, scope: 'Synthetic receipt fixture; no app installation or acceptance occurred.' });
    const report = { schemaVersion: 1, result: 'passed', artifactId: artifact.id, sourceSha: artifact.sourceSha, payloadSha256, profileIds: ['local-owner'], producer: { name: 'synthetic-fixture', version: '1', sourceSha: artifact.sourceSha }, checks: [
      { id: 'content-digest', profileId: null, platform: null, installMethod: null, required: true, result: 'passed', command: 'synthetic digest fixture' },
      { id: 'source-provenance', profileId: null, platform: null, installMethod: null, required: true, result: 'passed', command: 'synthetic provenance fixture' },
      { id: 'installed-runtime', profileId: 'local-owner', platform: 'Windows', installMethod: 'npm package', required: true, result: 'passed', command: 'synthetic runtime fixture' },
    ] };
    ledger.evidence.push(evidence);
    edit({ ledger, artifact, evidence, report });
    const bytes = JSON.stringify(report) + '\n';
    writeFileSync(join(fixture, location), bytes);
    evidence.raw = [{ location, sha256: createHash('sha256').update(bytes).digest('hex'), verification: 'local' }];
    return validateScorecard(ledger, { root: fixture });
  } finally {
    const cleanupPath = realpathSync(fixture);
    assert.equal(realpathSync(dirname(cleanupPath)), realpathSync(tmpdir()));
    assert.ok(basename(cleanupPath).startsWith('flujo-scorecard-'));
    rmSync(cleanupPath, { recursive: true, force: true });
  }
}
test('a valid producer receipt uses its own checksum and leaves grade acceptance open', () => {
  const result = artifactReportFixture();
  assert.deepEqual(result.errors, []);
  assert.ok(result.blockers.length > 0);
});
test('artifact receipts reject stale identity, missing runtime profiles and skipped provenance', () => {
  for (const edit of [
    ({ report }) => { report.sourceSha = '1'.repeat(40); },
    ({ report }) => { report.payloadSha256 = '0'.repeat(64); },
    ({ report }) => { report.checks[1].result = 'skipped'; },
    ({ evidence }) => { evidence.profileIds.push('persistent-worker'); },
    ({ report }) => { report.checks.push(structuredClone(report.checks[0])); },
  ]) {
    const result = artifactReportFixture(edit);
    assert.ok(result.errors.some(e => /identity\/digest mismatch|required content|duplicate artifact/.test(e)), result.errors.join('\n'));
  }
});
test('a matching npm digest and declared provenance do not qualify as installed acceptance', () => {
  rejects(l => { l.evidence.find(e => e.id === 'npm-content-inspection-3.46.2').kind = 'installed-artifact'; }, /needs a retained producer artifact report/);
  rejects(l => { l.artifacts.find(a => a.id === 'npm-3.46.2').provenance = 'verified-content'; }, /no matching retained content acceptance/);
});
test('one package/profile check cannot certify every platform or installation method', () => {
  const result = artifactReportFixture(({ ledger, evidence }) => {
    const row = ledger.profiles.find(p => p.id === 'local-owner').osInstallMatrix.find(m => m.platform === 'Windows');
    row.acceptance = 'verified';
    row.evidenceIds = [evidence.id];
  });
  assert.ok(result.errors.some(e => e.includes('missing installed acceptance for method versioned installer')));
  assert.ok(result.errors.some(e => e.includes('missing installed acceptance for method pinned source')));
  const wrong = artifactReportFixture(({ report }) => { report.checks[2].installMethod = 'versioned installer'; });
  assert.ok(wrong.errors.some(e => e.includes('does not match declared platform/install artifact')));
  rejects(l => { entry(l, 'profiles', 'local-owner').osInstallMatrix.pop(); }, /platforms: required complete set/);
  rejects(l => { entry(l, 'profiles', 'local-owner').osInstallMatrix[0].methods.pop(); }, /methods: required complete set/);
});
test('CLI distinguishes valid incomplete ledger from closure readiness and malformed input', () => {
  const run = args => spawnSync(process.execPath, ['scripts/validate-scorecard.mjs', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run([]).status, 0);
  const closure = run(['--closure']);
  assert.equal(closure.status, 2, closure.stderr);
  assert.match(closure.stdout, /Closure blockers/);
  assert.equal(run(['--award-A']).status, 1);
});

test('audit and full-soak gates reject evidence of the wrong source kind', () => {
  rejects(l => {
    const gate = entry(l, 'gates', 'persona-current-soak');
    gate.status = 'passed';
    gate.evidenceIds = ['publication-source-46af3225'];
  }, /wrong evidence kind/);
  rejects(l => {
    const witness = structuredClone(entry(l, 'evidence', 'baseline-2026-10-03'));
    Object.assign(witness, {id: 'synthetic-offline', kind: 'offline-simulation', window: {kind: 'simulated', start: null, end: null, simulatedDays: 28}});
    l.evidence.push(witness);
    const gate = entry(l, 'gates', 'dependency-audit');
    gate.status = 'passed';
    gate.evidenceIds = [witness.id];
  }, /wrong evidence kind/);
  rejects(l => { entry(l, 'gates', 'dependency-audit').kind = 'independent'; }, /required source gate kind changed/);
});

test('candidate verification and all production profiles remain mandatory', () => {
  rejects(l => { l.gates = l.gates.filter(g => g.id !== 'build-verification'); }, /Required gate omitted/);
  rejects(l => { entry(l, 'claims', 'docs-a-minus').gateIds = entry(l, 'claims', 'docs-a-minus').gateIds.filter(id => id !== 'build-verification'); }, /missing build-verification claim gate/);
  for (const profileId of ['local-owner', 'persistent-worker', 'shared-public']) {
    rejects(l => { l.claims = l.claims.filter(c => c.dimensionId !== 'production' || c.profileId !== profileId); }, /Missing production claim for profile/);
  }
});

test('unset envelopes cannot be agreed or used by measurements', () => {
  rejects(l => { entry(l, 'budgets', 'live-spend').status = 'agreed'; }, /unset envelope cannot/);
  rejects(l => {
    const e = entry(l, 'evidence', 'baseline-2026-10-03');
    e.budgetIds = ['live-spend'];
    e.metrics = [{budgetId: 'live-spend', value: 0, denominator: 1, numerator: null}];
  }, /envelope not declared/);
  rejects(l => { entry(l, 'budgets', 'persona-peak-rss').limit = null; }, /existing numeric contract changed/);
});

test('source-build receipts still require installed runtime checks', () => {
  const missing = artifactReportFixture(({artifact, report}) => {
    artifact.kind = 'source-build';
    report.checks = report.checks.filter(c => c.id !== 'installed-runtime');
  });
  assert.ok(missing.errors.some(e => /missing\/failed\/skipped required/.test(e)), missing.errors.join('\n'));
  const complete = artifactReportFixture(({artifact, report}) => {
    artifact.kind = 'source-build';
    report.checks.find(c => c.id === 'installed-runtime').installMethod = 'pinned source';
  });
  assert.deepEqual(complete.errors, []);
  assert.ok(complete.blockers.length > 0);
});
