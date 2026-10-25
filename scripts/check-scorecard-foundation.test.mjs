import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { foundationPath, initializeLedger, validateCollection, validateFoundation } from './check-scorecard-foundation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(root, foundationPath), 'utf8'));
const copy = () => structuredClone(contract);
function rejects(edit, pattern) {
  const value = copy(); edit(value);
  assert.match(validateFoundation(value).join('\n'), pattern);
}

test('maintained foundation preserves the complete original objective without a human development gate', () => {
  assert.deepEqual(validateFoundation(contract), []);
  assert.equal(contract.rubric.length, 9);
  assert.equal(contract.profiles.length, 3);
  assert.equal(contract.budgets.length, 30);
  assert.equal(contract.issueReconciliation.length, 11);
});
test('object key ordering is immaterial while unknown grade declarations fail closed', () => {
  const value = copy();
  value.scope = Object.fromEntries(Object.entries(value.scope).reverse());
  value.budgets[0].observation = Object.fromEntries(Object.entries(value.budgets[0].observation).reverse());
  assert.deepEqual(validateFoundation(value), []);
  rejects(v => { v.grade = 'A-'; }, /Unexpected\/missing contract fields/);
});
test('omitted and duplicate dimensions or accountable owners fail', () => {
  rejects(v => v.rubric.pop(), /complete set/);
  rejects(v => { v.rubric[1] = v.rubric[0]; }, /complete set/);
  rejects(v => v.owners.pop(), /owner|complete set/);
  rejects(v => { v.owners[0].kind = 'human'; }, /automated accountable owner/);
});
test('criteria, baseline grades, evidence kinds and linked work cannot be silently rewritten', () => {
  rejects(v => { v.rubric[0].originalGrade = 'A'; }, /baseline, grade/);
  rejects(v => { v.rubric[0].criteria = ['A nice demo']; }, /criteria\/evidence\/work/);
  rejects(v => { v.rubric[1].evidenceRequired = ['source-check']; }, /criteria\/evidence\/work/);
  rejects(v => { v.rubric[2].issues = []; }, /criteria\/evidence\/work/);
});
test('all three profiles, their trust boundaries and separate autonomy requirement remain required', () => {
  rejects(v => v.profiles.pop(), /complete set/);
  rejects(v => { v.scope.profileReduction = 'local-only'; }, /Original scope/);
  rejects(v => { v.scope.sharedPublicAndAutonomy = 'same'; }, /Original scope/);
  rejects(v => { v.profiles[2].trustBoundaries = ['login is enough']; }, /trustBoundaries/);
});
test('platform methods, experimental exclusions and actual Node prerequisites cannot disappear', () => {
  rejects(v => v.profiles[0].osInstallMatrix.pop(), /osInstallMatrix/);
  rejects(v => { v.profiles[1].exclusions = []; }, /exclusions/);
  rejects(v => { v.profiles[0].prerequisites[0] = 'Any Node'; }, /prerequisites/);
  rejects(v => { v.sourceBaseline.nodeRange = '>=22'; }, /Node prerequisites/);
});
test('a definition or automated development review cannot claim installed qualification or human agreement', () => {
  rejects(v => { v.profiles[0].supportedReleaseClaim = true; }, /not a qualified release/);
  rejects(v => { v.developmentPolicy.independentHumanReviewClaimed = true; }, /cannot claim human/);
  rejects(v => { v.developmentPolicy.externalGradeAgreementClaimed = true; }, /external grade/);
  rejects(v => { v.scope.externalGradeStatus = 'A-'; }, /unassessed grades/);
  rejects(v => { v.developmentPolicy.reviewerIdentity = v.developmentPolicy.maintainerIdentity; }, /Separate automated source review/);
});
test('human development approvals/responses cannot reappear as a hidden gate', () => {
  rejects(v => { v.developmentPolicy.humanApprovalRequired = true; }, /must not wait/);
  rejects(v => { v.developmentPolicy.humanResponseRequired = true; }, /must not wait/);
  rejects(v => { v.developmentPolicy.authority = ''; }, /policy reference/);
});
test('all numeric targets, denominators and simulated versus elapsed windows remain protected', () => {
  rejects(v => { v.budgets[0].limit = 170; }, /numeric target/);
  rejects(v => { v.budgets.find(b => b.id === 'pilot-users').denominator = 'bots'; }, /denominator/);
  rejects(v => { v.budgets.find(b => b.id === 'human-contributors').window = 'one day'; }, /window/);
  rejects(v => { v.budgets.find(b => b.id === 'live-28-days').observation.clock = 'simulated'; }, /window/);
});
test('human/community targets cannot become automated participant counts', () => {
  rejects(v => { v.budgets.find(b => b.id === 'pilot-users').unit = 'agents'; }, /numeric target/);
  rejects(v => { v.budgets.find(b => b.id === 'backup-maintainers').limit = 0; }, /numeric target/);
});
test('zero-dollar refusal is concrete and cannot claim funded positive or unknown spend', () => {
  rejects(v => { v.budgets.find(b => b.id === 'live-spend').limit = null; }, /zero-dollar/);
  rejects(v => { v.budgets.find(b => b.id === 'live-spend').limit = 25; }, /zero-dollar/);
  rejects(v => { v.budgets.find(b => b.id === 'live-spend').denominator = 'Unbilled tokens'; }, /zero-dollar/);
  rejects(v => { const budget = v.budgets.find(b => b.id === 'live-spend'); budget.denominator = 'unknown cost is not zero'; budget.basis = 'No attributable cost accounting'; }, /zero-dollar/);
});
test('declaration does not retroactively promote an old observation into a measured pass', () => {
  rejects(v => { v.budgets[0].measurementStatus = 'passed'; }, /future measurement/);
  rejects(v => { v.budgets[0].originalStatus = 'agreed'; }, /historical status/);
  rejects(v => { v.declaredAt = '2999-01-01T00:00:00Z'; }, /completed UTC/);
  rejects(v => { v.declaredAt = '2026-02-30T00:00:00Z'; }, /completed UTC/);
});
test('all requested issue reconciliations distinguish release qualification and preserve limits', () => {
  rejects(v => v.issueReconciliation.pop(), /complete set/);
  rejects(v => { v.issueReconciliation[0].selectedReleaseStatus = 'passed'; }, /must not qualify/);
  rejects(v => { v.issueReconciliation[0].scopeLimits = ''; }, /scope limits/);
});
test('raw identities, skipped/manual outcomes and the original closure validator remain required', () => {
  rejects(v => v.evidenceLedger.requiredFields.pop(), /measurement identity/);
  rejects(v => { v.evidenceLedger.allowedResults = ['passed']; }, /Failures\/skips/);
  rejects(v => { v.evidenceLedger.closureValidator = 'self-award'; }, /final-grade validator/);
});

// An actual committed throwaway repository exercises Git correspondence and output
// behavior without changing this checkout or qualifying any real distribution.
const fixture = mkdtempSync(join(tmpdir(), 'flujo-scorecard-foundation-'));
after(() => rmSync(fixture, { recursive: true, force: true }));
const source = join(fixture, 'source');
mkdirSync(join(source, 'docs/quality'), { recursive: true });
writeFileSync(join(source, foundationPath), JSON.stringify(contract, null, 2) + '\n');
writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '0.0.0-fixture', engines: { node: contract.sourceBaseline.nodeRange } }));
const git = args => execFileSync('git', args, { cwd: source, windowsHide: true, stdio: 'pipe' });
git(['init']);
git(['-c', 'core.autocrlf=false', 'add', '.']);
git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic foundation fixture']);
const collectionRoot = join(fixture, 'collection');
const collection = initializeLedger(collectionRoot, { root: source });
const validate = ledger => validateCollection(ledger, { root: source, evidenceRoot: collectionRoot });

test('clean-source initialization creates a real external frozen collection with no invented artifact or grade', () => {
  assert.deepEqual(validate(collection), []);
  assert.deepEqual(collection.assessment, { status: 'not-assessed', grades: [] });
  assert.equal(collection.distributions.filter(d => d.status === 'unselected').length, 3);
  assert.equal(collection.records.length, 0);
});
test('initialization refuses overwrite, a source-contained output and dirty source', () => {
  assert.throws(() => initializeLedger(collectionRoot, { root: source }), /already exists/);
  assert.throws(() => initializeLedger(join(source, 'records'), { root: source }), /outside/);
  writeFileSync(join(source, 'untracked'), 'dirty');
  try { assert.throws(() => initializeLedger(join(fixture, 'dirty'), { root: source }), /clean committed/); }
  finally { rmSync(join(source, 'untracked')); }
});
test('collection rejects source/tree/contract mismatch, grade awards and metadata promotion', () => {
  for (const edit of [v => { v.source.tree = 'a'.repeat(40); }, v => { v.contractSha256 = '0'.repeat(64); }, v => { v.assessment.grades = ['A-']; }, v => { v.distributions[0].status = 'verified-content'; }]) {
    const value = structuredClone(collection); edit(value); assert.ok(validate(value).length > 0);
  }
  const value = structuredClone(collection); value.source.sha = '--output=foreign';
  assert.match(validate(value).join('\n'), /full commit SHA/);
});
test('frozen collections use their immutable source package after current runtime requirements change', () => {
  const packagePath = join(source, 'package.json');
  const original = readFileSync(packagePath);
  writeFileSync(packagePath, JSON.stringify({ version: '9.9.9-current', engines: { node: '^30.0.0' } }));
  try { assert.deepEqual(validate(collection), []); }
  finally { writeFileSync(packagePath, original); }
  const forged = structuredClone(collection); forged.source.packageVersion = '9.9.9-invented';
  assert.match(validate(forged).join('\n'), /package version/);
});
const raw = Buffer.from('Synthetic source-check fixture; not an executed product workload.\n');
writeFileSync(join(collectionRoot, 'raw.log'), raw);
const stamp = new Date().toISOString();
const record = { id: 'fixture', kind: 'source-check', sourceSha: collection.source.sha, artifactIdentity: 'source:' + collection.source.sha, profileId: null,
  command: ['synthetic-fixture'], platform: process.platform, ownerId: contract.owners[0].id, startedAt: stamp, finishedAt: stamp, clock: 'instant', result: 'failed',
  rawLocation: 'raw.log', rawSha256: createHash('sha256').update(raw).digest('hex'), scopeLimits: ['Synthetic validator fixture only'], budgetIds: [], numerator: null, denominator: null };
test('failed/skipped/manual/unknown observations retain exact raw correspondence without acceptance', () => {
  for (const result of ['failed', 'skipped', 'manual', 'unknown']) {
    const value = structuredClone(collection); value.records = [{ ...record, result }]; assert.deepEqual(validate(value), []);
  }
});
test('collection refuses stale source, absent fields, zero denominators and pre-declaration observation', () => {
  for (const edit of [r => { r.sourceSha = 'a'.repeat(40); }, r => { delete r.command; }, r => { r.numerator = 0; r.denominator = 0; }, r => { r.startedAt = '2020-01-01T00:00:00Z'; }, r => { r.budgetIds = ['invented']; }, r => { r.artifactIdentity = 'npm:unselected'; }]) {
    const value = structuredClone(collection); value.records = [structuredClone(record)]; edit(value.records[0]); assert.ok(validate(value).length > 0);
  }
});
test('source passes cannot stand in for human, installed-runtime or live measurements', () => {
  for (const budgetId of ['pilot-users', 'runtime-peak-rss', 'live-seven-days']) {
    const value = structuredClone(collection); value.records = [{ ...record, result: 'passed', budgetIds: [budgetId] }];
    assert.match(validate(value).join('\n'), /wrong evidence kind/);
  }
});
test('passed kinds cannot contradict distribution/profile identity or actual elapsed observation floors', () => {
  for (const [kind, clock, budgetId, pattern] of [
    ['installed-artifact', 'instant', 'runtime-peak-rss', /selected distribution/],
    ['human-study', 'simulated', 'pilot-users', /elapsed clock/],
    ['live-provider', 'simulated', 'live-seven-days', /elapsed clock/],
    ['human-study', 'elapsed', 'pilot-users', /preregistered.*floor/],
  ]) {
    const value = structuredClone(collection); value.records = [{ ...record, result: 'passed', kind, clock, budgetIds: [budgetId], numerator: 1, denominator: 10 }];
    assert.match(validate(value).join('\n'), pattern);
  }
});
test('collection refuses changed raw content and paths outside its evidence root', () => {
  const value = structuredClone(collection); value.records = [{ ...record, rawSha256: '0'.repeat(64) }];
  assert.match(validate(value).join('\n'), /checksum mismatch/);
  value.records[0] = { ...record, rawLocation: '../source/package.json' };
  assert.match(validate(value).join('\n'), /escapes/);
});
