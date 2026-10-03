import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateScorecard, validateShape } from './validate-scorecard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(join(root, 'docs/audits/scorecard-563/scorecard.json'), 'utf8'));
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
  rejects(l => { l.claims[0].evidenceIds = ['invented-pass']; }, /unknown evidence ID/);
  rejects(l => { l.issueReconciliation[0].issue = 999; }, /required complete set/);
  rejects(l => { l.gates[0].evidenceIds = ['baseline-2026-10-03', 'baseline-2026-10-03']; }, /duplicate references/);
});
test('existing Persona thresholds cannot be weakened and historical failure cannot disappear', () => {
  rejects(l => { l.budgets.find(b => b.id === 'persona-append-p95').limit = 170; }, /existing numeric contract changed/);
  rejects(l => { l.budgets.find(b => b.id === 'persona-rss-growth').operator = '<'; }, /existing numeric contract changed/);
  rejects(l => { l.evidence.find(e => e.id === 'persona-september16-failure').result = 'passed'; }, /contradicts measured|Historical/);
  rejects(l => { l.evidence = l.evidence.filter(e => e.id !== 'persona-september16-failure'); }, /Historical/);
});
test('raw payload tampering, absent checksums and outside paths are rejected', () => {
  rejects(l => { l.evidence[0].raw[0].sha256 = '0'.repeat(64); }, /checksum mismatch/);
  rejects(l => { l.evidence[0].raw[0].sha256 = null; }, /missing SHA-256|needs a retained/);
  rejects(l => { l.evidence[0].raw[0].location = '../outside.json'; }, /escapes repository/);
  rejects(l => { l.evidence[0].raw[0].location = 'C:/private/file.json'; }, /repository-relative/);
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
    ledger.evidence[0].raw[0].location = 'link/witness.json';
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
    l.claims[0].status = 'release-supported';
    l.claims[0].evidenceIds = ['verify-main-reported'];
  }, /passing checksummed|installed-artifact acceptance/);
  rejects(l => { l.gates[1].status = 'passed'; l.gates[1].evidenceIds = ['baseline-2026-10-03']; }, /wrong evidence kind/);
  rejects(l => { l.artifacts[1].provenance = 'verified-content'; }, /verified content needs|no matching retained/);
});
test('live/human evidence cannot use simulation or unbound release identity', () => {
  rejects(l => { l.evidence[2].kind = 'live-provider'; }, /actual elapsed window/);
  rejects(l => { l.evidence[0].kind = 'human-study'; }, /actual elapsed window/);
  rejects(l => { l.evidence[0].kind = 'installed-artifact'; }, /matching release artifact/);
});
test('measured results reject false pass, zero denominator and postdeclared budgets', () => {
  rejects(l => { l.evidence[3].metrics[0].denominator = 0; }, /below minimum/);
  rejects(l => {
    const e = l.evidence[0];
    e.budgetIds = ['novice-success'];
    e.metrics = [{ budgetId: 'novice-success', value: 8, denominator: 10 }];
  }, /proposed budget cannot establish acceptance/);
  rejects(l => {
    const e = l.evidence[0];
    e.budgetIds = ['persona-peak-rss'];
    e.metrics = [{ budgetId: 'persona-peak-rss', value: 1, denominator: 28 }];
    e.window = { kind: 'elapsed', start: '2026-10-02T00:00:00Z', end: '2026-10-02T01:00:00Z', simulatedDays: null };
  }, /budget declared after measurement/);
});
test('mixed revisions and source-only evidence cannot support one accepted release', () => {
  rejects(l => {
    const newer = structuredClone(l.evidence[0]);
    newer.id = 'different-revision';
    newer.sourceSha = '1'.repeat(40);
    l.evidence.push(newer);
    const c = l.claims[0];
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
    const c = l.claims[0];
    c.status = 'source-supported';
    c.requiredKinds = ['baseline-observation'];
    c.evidenceIds = ['baseline-2026-10-03'];
    l.evidence[0].profileIds = ['persistent-worker'];
  }, /does not cover claimed profile/);
  rejects(l => { l.gates = l.gates.filter(g => g.id !== 'shared-profile'); }, /Required gate omitted/);
});
test('CLI distinguishes valid incomplete ledger from closure readiness and malformed input', () => {
  const run = args => spawnSync(process.execPath, ['scripts/validate-scorecard.mjs', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(run([]).status, 0);
  const closure = run(['--closure']);
  assert.equal(closure.status, 2, closure.stderr);
  assert.match(closure.stdout, /Closure blockers/);
  assert.equal(run(['--award-A']).status, 1);
});
