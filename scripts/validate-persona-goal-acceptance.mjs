import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import fixture from './persona-goal-acceptance/fixture.cjs';
import terminalFixture from './persona-goal-acceptance/terminal-fixture.cjs';

const requiredChecks = [
  'oneInitialGoal', 'autonomousContinuation', 'verifiedDeliverables',
  'noHumanIntervention', 'noPrematureStop', 'controllerRestartRecovery',
  'transientFailureRecovery', 'environmentBootstrapRecovery', 'actualModelObserved',
];

export async function validatePersonaGoalAcceptance({ directory, expectedCommit, expectedMode, expectedSourceDiffSha256 }) {
  const raw = await fs.readFile(path.join(directory, 'persona-goal-acceptance.json'), 'utf8');
  const report = JSON.parse(raw);
  const errors = [];
  const terminalOnly = report.configuration?.toolsMode === 'terminal-only';
  const required = terminalOnly ? [...requiredChecks, 'browserExecution'] : requiredChecks;
  const assert = (condition, message) => { if (!condition) errors.push(message); };
  assert(report.schemaVersion === 1 && report.runId, 'Schema/run identity is missing.');
  assert(report.commitSha === expectedCommit && /^[a-f0-9]{40}$/.test(report.commitSha ?? ''), 'Commit identity mismatch.');
  assert(report.mode === expectedMode && ['offline', 'live'].includes(report.mode), 'Mode identity mismatch.');
  assert(/^[a-f0-9]{64}$/.test(report.sourceDiffSha256 ?? '') && (!expectedSourceDiffSha256 || report.sourceDiffSha256 === expectedSourceDiffSha256), 'Source-diff identity mismatch.');
  assert(Number.isFinite(Date.parse(report.startedAt)) && Date.parse(report.endedAt) >= Date.parse(report.startedAt), 'Invalid run timestamps.');
  assert(required.every(id => report.checks?.[id] === true), 'A required goal-acceptance check is missing or not passed.');
  assert(Object.keys(report.checks ?? {}).length === required.length, 'Unexpected goal-acceptance criterion registry.');
  const model = report.configuration?.model;
  assert(model?.name && model?.id && (report.mode !== 'live' || model.adapter === 'codex-cli'), 'Configured model identity is invalid.');
  assert(Array.isArray(report.modelCalls) && report.modelCalls.length > 0 && report.modelCalls.every(call => call.model === model?.name && call.adapter === model?.adapter), 'Actual model observations do not match the configuration.');
  const goals = report.goals ?? [];
  const goalId = report.configuration?.goalId;
  assert(goals.length === 1 && goals[0].id === goalId && goals[0].goal?.state === 'completed', 'Exactly one completed initial goal is required.');
  const goalTasks = report.goalTasks ?? [];
  const taskIds = new Set([goalId, ...goalTasks.map(task => task.id)]);
  const mailbox = report.mailbox ?? [];
  const admitted = mailbox.filter(item => item.source?.kind === 'assignment' && taskIds.has(item.source?.sourceId));
  const activities = (report.activities ?? []).filter(activity => activity.source?.kind === 'assignment' && taskIds.has(activity.source?.sourceId));
  assert(new Set(admitted.map(item => item.idempotencyKey)).size >= 3 && activities.length >= 3, 'Insufficient distinct persisted autonomous admissions.');
  assert(admitted.every(item => activities.some(activity => activity.id === item.claimedActivityId)), 'Autonomous mailbox/Activity linkage is incomplete.');
  assert(mailbox.every(item => item.source?.kind !== 'chat') && (report.snapshots ?? []).every(snapshot => !snapshot.goal?.interventionReason && snapshot.goal?.state !== 'needs_input'), 'Observed human input or intervention request.');
  assert(Number.isFinite(report.observations?.restartAt)
    && activities.some(activity => activity.createdAt >= report.observations.restartAt)
    && (goals[0]?.goal?.rounds ?? 0) > (report.observations?.roundsBeforeRestart ?? Infinity), 'Controller restart has no persisted subsequent Activity.');
  const actual = await (terminalOnly ? terminalFixture : fixture).verifyFixture(path.join(directory, 'fixture'));
  assert(actual.artifacts.length === 2 && actual.artifacts.every(artifact => artifact.verified) && actual.publicationVerified, 'Actual artifacts/publication do not match researched facts and content hashes.');
  assert(actual.environmentBootstrapVerified && actual.transientFailureObserved && actual.publishAttempts >= 2, 'Actual bootstrap/outage recovery evidence is incomplete.');
  if (terminalOnly) assert(report.mode === 'live' && actual.browserExecutionVerified, 'Terminal-only evidence requires a live model and observed real browser execution.');
  assert(JSON.stringify(actual) === JSON.stringify(report.external), 'Report differs from independent external fixture evidence.');
  const checksum = (await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim();
  assert(checksum === `${createHash('sha256').update(raw).digest('hex')}  persona-goal-acceptance.json`, 'Evidence checksum mismatch.');
  if (errors.length) throw new Error(`Persona goal acceptance validation failed:\n- ${errors.join('\n- ')}`);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const values = new Map(process.argv.slice(2).map(argument => {
    const match = /^--(directory|commit|mode|source-diff)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    return [match[1], match[2]];
  }));
  if (!values.get('directory') || !values.get('commit') || !values.get('mode')) throw new Error('--directory, --commit and --mode are required.');
  await validatePersonaGoalAcceptance({ directory: path.resolve(values.get('directory')), expectedCommit: values.get('commit'), expectedMode: values.get('mode'), expectedSourceDiffSha256: values.get('source-diff') });
  process.stdout.write('Validated Persona goal acceptance against persisted admissions and actual external effects.\n');
}
