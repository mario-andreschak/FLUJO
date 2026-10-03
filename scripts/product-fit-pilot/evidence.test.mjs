import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emptyPilot, summarizePilot, publicSummary } from './evidence.mjs';

const DAY = 86_400_000;
const START = Date.parse('2026-01-05T00:00:00.000Z');
const AS_OF = '2026-03-02T00:00:00.000Z';
const NOW = Date.parse('2026-10-03T00:00:00.000Z');
const time = offset => new Date(START + offset).toISOString();
const hash = value => value.toString(16).padStart(64, '0');
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));

// Everything in this generator is synthetic, including the negative controls
// exercising the human-mode calculation. It is never pilot/user evidence.
function fixture() {
  const data = emptyPilot();
  data.evidenceMode = 'synthetic-fixture';
  data.rubric.status = 'agreed';
  data.rubric.agreementSha256 = hash(100);
  data.startedAt = time(0);
  data.artifacts = [{ id: 'a001', kind: 'npm', version: '3.46.2', sourceCommit: 'a'.repeat(40), sha256: hash(101) }];
  data.workflows = [1, 2, 3].map(i => ({ id: `w00${i}`, purpose: 'normal-workflow', protocolSha256: hash(i) }));
  for (let i = 1; i <= 10; i++) {
    const participantId = `p${String(i).padStart(3, '0')}`;
    data.participants.push({ id: participantId, role: 'independent-human', novice: true, enrolledAt: time(0),
      consent: { version: 'pilot-v1', collectedAt: time(0), collection: true, publication: 'aggregate-only', withdrawnAt: null } });
    data.journeys.push({ participantId, artifactId: 'a001', startedAt: time(1000), endedAt: time(901_000),
      provisioningSeconds: 60, coaching: false, coding: false, status: 'completed', mcpToolCompleted: true,
      modelReplyCompleted: true, receiptSha256: hash(200 + i), dropOff: 'none', failureCode: 'none' });
    for (let week = 1; week <= 8; week++) {
      data.weeks.push({ participantId, week, reportedAt: time(week * 7 * DAY), tasks: data.workflows.map((w, j) => ({
        workflowId: w.id, artifactId: 'a001', completedAt: time((week - 1) * 7 * DAY + DAY),
        outcome: 'completed', mcpUsed: true, receiptSha256: hash(1000 + i * 100 + week * 3 + j),
        benefit: 'connection-reuse', interventions: 0, failureCode: 'none',
      })) });
    }
  }
  return data;
}

const report = data => summarizePilot(data, AS_OF, NOW);

test('empty proposed pilot has no human observations or acceptance', () => {
  const result = report(emptyPilot());
  assert.equal(result.cohort.enrolled, 0);
  assert.equal(result.completeWeeks, 0);
  assert.ok(Object.values(result.gates).every(value => value === 'pending-agreement'));
});

test('eight synthetic weeks never award human acceptance or a grade', () => {
  const result = report(fixture());
  assert.equal(result.cohort.retainedThroughCompleteWeeks, 10);
  assert.equal(result.workflows.recurringWithRecordedBenefit, 3);
  assert.equal(result.tasks.completed, 240);
  assert.ok(Object.values(result.gates).every(value => value === 'fixture-only'));
  assert.equal(result.externalReassessment, 'required');
});

test('calendar time and the intersection of weekly users control retention', () => {
  const data = fixture();
  data.evidenceMode = 'human-observations';
  data.weeks = data.weeks.filter(w => w.week < 8);
  const partial = summarizePilot(data, time(49 * DAY), NOW);
  assert.equal(partial.completeWeeks, 7);
  assert.equal(partial.cohort.retainedThroughCompleteWeeks, 10);
  assert.equal(partial.gates.weeklyAdoption, 'pending-evidence');
  const complete = report(data);
  assert.equal(complete.cohort.retainedThroughCompleteWeeks, 0);
  assert.equal(complete.weekly[7].missing, 10);
  assert.equal(complete.weekly[7].inactive, 0);
});

test('missing and reported inactive weeks remain distinct; gaps break retention', () => {
  const data = fixture();
  data.weeks = data.weeks.filter(w => !(w.participantId === 'p001' && w.week === 3));
  data.weeks.find(w => w.participantId === 'p002' && w.week === 3).tasks = [];
  const result = report(data);
  assert.deepEqual(result.weekly[2], { week: 3, enrolled: 10, reported: 9, missing: 1, active: 8, inactive: 1 });
  assert.equal(result.cohort.retainedThroughCompleteWeeks, 8);
});

test('maintainers, automated/promotional participants, and late joins do not fill the fixed cohort', () => {
  const data = fixture();
  data.participants[0].role = 'maintainer';
  data.participants[1].role = 'automated';
  data.participants[2].role = 'promotional';
  data.participants[3].enrolledAt = time(500);
  const result = report(data);
  assert.equal(result.cohort.enrolled, 6);
  assert.equal(result.cohort.excluded, 4);
  assert.equal(result.novices.enrolled, 6);
});

test('withdrawal requires deleting observations and keeps the original cohort denominator', () => {
  const data = fixture();
  data.participants[0].consent.withdrawnAt = time(55 * DAY);
  assert.throws(() => report(data), /remove withdrawn participant observations/);
  for (const key of ['journeys', 'weeks', 'feedback']) data[key] = data[key].filter(r => r.participantId !== 'p001');
  const result = report(data);
  assert.equal(result.cohort.enrolled, 10);
  assert.equal(result.cohort.withdrawn, 1);
  assert.equal(result.cohort.retainedThroughCompleteWeeks, 9);
  assert.equal(result.novices.missing, 1);
});

test('first-run failures cannot be replaced by retries or omitted from the denominator', () => {
  const data = fixture();
  const journey = data.journeys[0];
  Object.assign(journey, { status: 'provisioning-blocked', mcpToolCompleted: false, modelReplyCompleted: false,
    dropOff: 'model', failureCode: 'authentication', receiptSha256: null, provisioningSeconds: 900 });
  data.journeys.splice(1, 1);
  const result = report(data);
  assert.equal(result.novices.enrolled, 10);
  assert.equal(result.novices.successfulWithinTarget, 8);
  assert.equal(result.novices.failedOrAbandoned, 1);
  assert.equal(result.novices.provisioningBlocked, 1);
  assert.equal(result.novices.missing, 1);
  data.journeys.push({ ...journey });
  assert.throws(() => report(data), /first attempt once/);
});

test('provisioning is excluded from timing; coaching, coding and slow runs fail novice target', () => {
  const data = fixture();
  data.journeys[0].coaching = true;
  data.journeys[1].coding = true;
  data.journeys[2].endedAt = time(1_000_000);
  const result = report(data);
  assert.equal(result.novices.successfulWithinTarget, 7);
  assert.equal(result.novices.coached, 1);
  assert.equal(result.novices.coded, 1);
  assert.equal(result.novices.productSeconds[0], 840);
});

test('source-only checks cannot prove installed adoption, benefits or novice completion', () => {
  const data = fixture();
  data.artifacts[0].kind = 'source';
  const result = report(data);
  assert.equal(result.cohort.retainedThroughCompleteWeeks, 0);
  assert.equal(result.workflows.recurringWithRecordedBenefit, 0);
  assert.equal(result.novices.successfulWithinTarget, 0);
  assert.equal(result.tasks.sourceOnly, 240);
});

test('repeated practice tasks cannot fill weekly adoption even when actual humans run them', () => {
  const data = fixture();
  data.evidenceMode = 'human-observations';
  for (const workflow of data.workflows) workflow.purpose = 'practice-fixture';
  const result = report(data);
  assert.equal(result.cohort.retainedThroughCompleteWeeks, 0);
  assert.equal(result.tasks.practice, 240);
  assert.equal(result.novices.successfulWithinTarget, 10);
  assert.equal(result.gates.weeklyAdoption, 'pending-evidence');
});

test('recurring benefit needs the same participant and protocol on separate weeks', () => {
  const data = fixture();
  for (const week of data.weeks) for (const task of week.tasks) task.benefit = 'unmeasured';
  data.weeks[0].tasks[0].benefit = 'time-saved';
  data.weeks[8].tasks[0].benefit = 'time-saved'; // another person, same week
  assert.equal(report(data).workflows.recurringWithRecordedBenefit, 0);
  data.weeks[1].tasks[0].benefit = 'time-saved';
  assert.equal(report(data).workflows.recurringWithRecordedBenefit, 1);
  data.workflows[0].purpose = 'practice-fixture';
  assert.equal(report(data).workflows.recurringWithRecordedBenefit, 0);
});

test('severe feedback requires a tracked fix and confirmation on a matching installed candidate', () => {
  const data = fixture();
  const feedback = { id: 'f001', participantId: 'p001', reportedAt: time(DAY), category: 'runtime', severity: 'severe',
    failureCode: 'runtime', issueNumber: 577, fixCommit: 'a'.repeat(40), confirmedArtifactId: null, confirmedAt: null, confirmationSha256: null };
  data.feedback.push(feedback);
  assert.equal(report(data).feedback.unresolvedSevere, 1);
  Object.assign(feedback, { confirmedArtifactId: 'a001', confirmedAt: time(2 * DAY), confirmationSha256: hash(900) });
  assert.equal(report(data).feedback.unresolvedSevere, 0);
  feedback.confirmedAt = time(57 * DAY);
  assert.throws(() => report(data), /confirmation outside/);
  feedback.confirmedAt = time(2 * DAY);
  data.artifacts[0].kind = 'source';
  assert.equal(report(data).feedback.unresolvedSevere, 1);
  data.artifacts[0].sourceCommit = 'b'.repeat(40);
  assert.throws(() => report(data), /fixed candidate revision/);
});

test('failed runs stay pending until triaged, and an earlier classification cannot hide recurrence', () => {
  const data = fixture();
  data.evidenceMode = 'human-observations';
  const task = data.weeks[0].tasks[0];
  Object.assign(task, { outcome: 'failed', receiptSha256: null, benefit: 'none', failureCode: 'runtime' });
  assert.equal(report(data).feedback.unclassifiedFailures, 1);
  assert.equal(report(data).gates.severeFailuresConfirmed, 'pending-evidence');
  data.feedback.push({ id: 'f001', participantId: 'p001', reportedAt: time(DAY + 1000), category: 'runtime',
    severity: 'minor', failureCode: 'runtime', issueNumber: null, fixCommit: null,
    confirmedArtifactId: null, confirmedAt: null, confirmationSha256: null });
  assert.equal(report(data).feedback.unclassifiedFailures, 0);
  assert.equal(report(data).gates.severeFailuresConfirmed, 'recorded-target-met');
  Object.assign(data.weeks[1].tasks[0], { outcome: 'failed', receiptSha256: null, benefit: 'none', failureCode: 'runtime' });
  assert.equal(report(data).feedback.unclassifiedFailures, 1);
  assert.equal(report(data).gates.severeFailuresConfirmed, 'pending-evidence');
});

function control(kind, ordinal = 1) {
  const checks = {
    approval: { blockedBeforeDecision: true, approvedAfterReview: true, rejectionPreventedCall: true },
    debugger: { pausedAtNode: true, inspectedToolResult: true, resumedToCompletion: true },
    'proxy-reuse': { sameConnection: true, discoveryCompleted: true, invocationCompleted: true },
  };
  return { participantId: 'p001', artifactId: 'a001', kind, observedAt: time(2 * DAY + ordinal * 1000),
    outcome: 'completed', checks: checks[kind], receiptSha256: hash(10_000 + ordinal), failureCode: 'none' };
}

test('approval, debugger and actual proxy reuse have independent installed/source evidence', () => {
  const data = fixture();
  data.controls = [control('approval', 1), control('debugger', 2), control('proxy-reuse', 3)];
  const result = report(data);
  for (const kind of ['approval', 'debugger', 'proxy-reuse']) {
    assert.deepEqual(result.controls[kind], { reportedParticipants: 1, missingParticipants: 9,
      completedOnInstalled: 1, failedAttempts: 0, notAttempted: 0, sourceOnly: 0 });
  }
  const published = publicSummary(data, result);
  assert.equal(published.controls, undefined);
  assert.ok(!JSON.stringify(published).includes(data.controls[0].receiptSha256));
  data.artifacts[0].kind = 'source';
  assert.equal(report(data).controls.approval.completedOnInstalled, 0);
  assert.equal(report(data).controls.approval.sourceOnly, 1);
});

test('control failures, explicit non-attempts and missing observations stay distinct', () => {
  const data = fixture();
  data.evidenceMode = 'human-observations';
  data.controls = [control('approval')];
  Object.assign(data.controls[0], { outcome: 'failed', failureCode: 'approval', receiptSha256: null });
  data.controls[0].checks.rejectionPreventedCall = false;
  assert.equal(report(data).controls.approval.failedAttempts, 1);
  assert.equal(report(data).feedback.unclassifiedFailures, 1);
  assert.equal(report(data).gates.severeFailuresConfirmed, 'pending-evidence');
  data.controls[0].outcome = 'not-attempted';
  data.controls[0].failureCode = 'none';
  for (const key of Object.keys(data.controls[0].checks)) data.controls[0].checks[key] = false;
  assert.equal(report(data).controls.approval.notAttempted, 1);
  assert.equal(report(data).controls.approval.missingParticipants, 9);
  assert.equal(report(data).controls.debugger.missingParticipants, 10);
  assert.equal(report(data).feedback.unclassifiedFailures, 0);
});

test('completed control evidence requires every boundary, a unique receipt and a valid consented time', () => {
  const mutations = [
    [d => { d.controls[0].checks.blockedBeforeDecision = false; }, /every control boundary/],
    [d => { d.controls[0].receiptSha256 = null; }, /invalid digest/],
    [d => { d.controls[0].observedAt = time(57 * DAY); }, /observation outside/],
    [d => { d.controls.push(structuredClone(d.controls[0])); }, /duplicate control attempt/],
    [d => { const duplicate = structuredClone(d.controls[0]); duplicate.observedAt = time(3 * DAY); d.controls.push(duplicate); }, /receipt cannot count twice/],
    [d => { d.controls[0].checks.privatePayload = 'do-not-print'; }, /unexpected or missing fields/],
    [d => { d.participants[0].consent.withdrawnAt = time(55 * DAY); d.journeys = []; d.weeks = []; }, /remove withdrawn/],
  ];
  for (const [mutate, message] of mutations) {
    const data = fixture();
    data.controls = [control('approval')];
    mutate(data);
    assert.throws(() => report(data), message);
  }
});

test('an agreed but unobserved cohort cannot clear the failure-confirmation gate', () => {
  const data = fixture();
  data.evidenceMode = 'human-observations';
  data.journeys = [];
  data.weeks = [];
  data.controls = [control('approval')];
  data.controls[0].outcome = 'not-attempted';
  data.controls[0].receiptSha256 = null;
  for (const key of Object.keys(data.controls[0].checks)) data.controls[0].checks[key] = false;
  assert.equal(report(data).gates.severeFailuresConfirmed, 'pending-evidence');
});

test('unknown fields are rejected without printing their names or contents', () => {
  const data = fixture();
  data.participants[0]['secret-key-name'] = 'secret-value';
  assert.throws(() => report(data), error => !error.message.includes('secret') && /unexpected or missing fields/.test(error.message));
});

test('references, uniqueness, consent, dates and pre-enrollment agreement are enforced', () => {
  const mutations = [
    [d => { d.weeks[0].tasks[0].artifactId = 'a999'; }, /unknown artifact/],
    [d => { d.weeks.push(d.weeks[0]); }, /duplicate participant-week/],
    [d => { d.weeks[1].tasks[0].receiptSha256 = d.weeks[0].tasks[0].receiptSha256; }, /cannot count twice/],
    [d => { d.journeys[1].receiptSha256 = d.journeys[0].receiptSha256; }, /distinct receipts/],
    [d => { d.workflows[1].protocolSha256 = d.workflows[0].protocolSha256; }, /distinct workflows/],
    [d => { d.participants[0].consent.collection = false; }, /affirmative protocol consent/],
    [d => { d.journeys[0].startedAt = '2026-02-30T00:00:00.000Z'; }, /real UTC/],
    [d => { d.weeks[0].reportedAt = time(DAY); }, /completed week/],
    [d => { d.evidenceMode = 'human-observations'; d.rubric.status = 'proposed'; }, /agree the rubric/],
    [d => { d.journeys[0].provisioningSeconds = 901; }, /integer/],
  ];
  for (const [mutate, message] of mutations) {
    const data = fixture();
    mutate(data);
    assert.throws(() => report(data), message);
  }
  assert.throws(() => summarizePilot(emptyPilot(), '2026-10-04T00:00:00.000Z', NOW), /future observations/);
});

test('public export honors consent and suppresses small cells including complementary counts', () => {
  const data = fixture();
  data.journeys[0].coaching = true;
  const published = publicSummary(data, report(data));
  assert.equal(published.novices, null); // 9 successes disclose a cell of one
  assert.equal(published.gates.noviceFirstRun, 'suppressed');
  assert.ok(!JSON.stringify(published).includes('p001'));
  assert.ok(!JSON.stringify(published).includes(data.artifacts[0].sourceCommit));
  data.participants[0].role = 'maintainer';
  assert.equal(publicSummary(data, report(data)).cohort, null); // excluded cell of one
  data.participants[0].consent.publication = 'private-only';
  const withheld = publicSummary(data, report(data));
  assert.equal(withheld.publication, 'withheld-by-consent');
  assert.equal(withheld.cohort, null);
  assert.equal(withheld.gates, null);
});

test('CLI starts empty, refuses overwrite, binds private reports, and redacts parse/OS errors', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'flujo-pilot-test-'));
  const input = join(folder, 'pilot.json');
  const output = join(folder, 'report.json');
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(run(['init', '--out', input]).status, 0);
  assert.equal(run(['init', '--out', input]).status, 1);
  const result = run(['report', '--input', input, '--as-of', AS_OF, '--private-output', output]);
  assert.equal(result.status, 0, result.stderr);
  const privateReport = JSON.parse(await readFile(output, 'utf8'));
  assert.match(privateReport.inputSha256, /^[a-f0-9]{64}$/);
  assert.match(privateReport.toolSha256.evidence, /^[a-f0-9]{64}$/);
  assert.equal(run(['report', '--input', input, '--as-of', AS_OF, '--private-output', output]).status, 1);
  await writeFile(input, '{"credential":"do-not-print-this"');
  const invalid = run(['report', '--input', input, '--as-of', AS_OF]);
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stderr.includes('do-not-print-this'));
  const missing = run(['report', '--input', join(folder, 'private-name.json'), '--as-of', AS_OF]);
  assert.ok(!missing.stderr.includes('private-name'));
});

test('CLI bounds input and fails invalid arguments without writing an output', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'flujo-pilot-test-'));
  const input = join(folder, 'too-large.json');
  await writeFile(input, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  const result = spawnSync(process.execPath, [cli, 'report', '--input', input, '--as-of', AS_OF], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /4 MiB/);
  const invalid = spawnSync(process.execPath, [cli, 'init', '--out', input, '--out', input], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
});
