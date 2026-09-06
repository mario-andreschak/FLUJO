import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENDURANCE_EVIDENCE_FILES,
  verifyEnduranceEvidenceAttestation,
} from './persona-goal-acceptance/endurance-attestation.mjs';
import { validatePublicFixtureManifest } from './persona-goal-acceptance/public-fixture-manifest.mjs';

const requiredChecks = [
  'oneOngoingGoal',
  'ordinaryMarketingSetup',
  'multipleAutonomousWakeups',
  'gracefulProcessRestart',
  'forcedProcessRecovery',
  'effectReconciliation',
  'verifiedUsefulProgress',
  'recoverableFailureContinuation',
  'ownerControlsPersisted',
  'noUnscheduledIntervention',
  'durationSatisfied',
  'cleanupCompleted',
  'browserExecution',
  'actualModelObserved',
];
const sha256 = value => createHash('sha256').update(value).digest('hex');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, stableValue(value[key])]));
}

const stableJson = value => JSON.stringify(stableValue(value));

async function readJsonLines(filename) {
  return (await fs.readFile(filename, 'utf8')).trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line));
}

function verifiedContent(content, facts) {
  return typeof content === 'string' && content.length >= 80
    && [facts.sourceId, facts.audience, facts.benefit].every(value => content.includes(value));
}

export async function validatePersonaGoalEndurance({
  directory,
  expectedCommit,
  expectedMode,
  expectedProfile,
  expectedSourceDiffSha256,
  expectedAttestationKeySha256,
}) {
  const root = path.resolve(directory);
  const reportPath = path.join(root, 'persona-goal-endurance.json');
  const [
    raw,
    runtimeModelTurnsRaw,
    runtimeProvenanceRaw,
    manifestRaw,
    trustedStateRaw,
    trustedAudit,
    checksumRaw,
  ] = await Promise.all([
    fs.readFile(reportPath, 'utf8'),
    fs.readFile(path.join(root, 'runtime-model-turns.json'), 'utf8'),
    fs.readFile(path.join(root, 'runtime-provenance.json'), 'utf8'),
    fs.readFile(path.join(root, 'trusted-verifier', 'manifest.json'), 'utf8'),
    fs.readFile(path.join(root, 'trusted-verifier', 'state.json'), 'utf8'),
    readJsonLines(path.join(root, 'trusted-verifier', 'audit.jsonl')),
    fs.readFile(path.join(root, 'SHA256SUMS'), 'utf8'),
  ]);
  const { attestation } = await verifyEnduranceEvidenceAttestation({
    directory: root,
    expectedPublicKeySha256: expectedAttestationKeySha256,
  });
  const report = JSON.parse(raw);
  const runtimeModelTurns = JSON.parse(runtimeModelTurnsRaw);
  const runtimeProvenance = JSON.parse(runtimeProvenanceRaw);
  const manifest = validatePublicFixtureManifest(JSON.parse(manifestRaw));
  const trustedState = JSON.parse(trustedStateRaw);
  const errors = [];
  const assert = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const validTime = value => Number.isFinite(Date.parse(value));
  const intervalMs = interval => Date.parse(interval.endedAt) - Date.parse(interval.startedAt);

  assert(report.schemaVersion === 1 && report.status === 'completed', 'Evidence is not a completed schema-v1 run.');
  const identity = report.runIdentity ?? {};
  assert(typeof identity.runId === 'string' && identity.runId === trustedState.runId, 'Run identity does not match trusted service evidence.');
  assert(identity.commitSha === expectedCommit && /^[a-f0-9]{40}$/.test(identity.commitSha ?? ''), 'Commit identity mismatch.');
  assert(identity.sourceDiffSha256 === expectedSourceDiffSha256
    && /^[a-f0-9]{64}$/.test(identity.sourceDiffSha256 ?? ''), 'Source-diff identity mismatch.');
  assert(attestation.payload?.runId === identity.runId
    && attestation.payload?.commitSha === identity.commitSha
    && attestation.payload?.sourceDiffSha256 === identity.sourceDiffSha256,
    'Runner attestation is not bound to the evidence identity.');
  assert(identity.mode === expectedMode && ['offline', 'live'].includes(identity.mode), 'Mode identity mismatch.');
  assert(identity.profile === expectedProfile
    && identity.profile === 'structured-tools', 'Capability profile mismatch or unsupported terminal execution.');
  assert(identity.authoritativeLiveModel === (identity.mode === 'live'), 'Live-model authority flag is inconsistent.');
  assert(identity.verifierVersion === 'persona-goal-endurance-v1'
    && identity.policyVersion === 'issue-505-endurance-metrics-v1', 'Evidence policy/verifier identity mismatch.');
  assert(validTime(identity.startedAt) && validTime(identity.endedAt)
    && Date.parse(identity.endedAt) >= Date.parse(identity.startedAt), 'Run timestamps are invalid.');

  const configuration = report.configuration ?? {};
  assert(configuration.roleName === 'Marketing Agent'
    && configuration.personaName === 'Frederik'
    && configuration.initialGoal === 'Make FLUJO known on the internet'
    && configuration.completionPolicy === 'until_stopped', 'Ordinary ongoing-goal configuration is missing.');
  assert(configuration.concurrency === 1, 'Endurance execution must have concurrency one per account/profile.');
  assert(Number.isFinite(configuration.budgetUsd) && configuration.budgetUsd >= 0
    && (identity.mode !== 'live' || configuration.budgetUsd > 0), 'Budget contract is invalid.');
  assert(Number.isSafeInteger(configuration.roundLimit) && configuration.roundLimit >= 6, 'Round limit is invalid.');
  assert(Number.isSafeInteger(configuration.maxModelCalls) && configuration.maxModelCalls > 0,
    'Model-call limit is invalid.');
  assert(Number.isSafeInteger(configuration.requestedDurationMs)
    && configuration.requestedDurationMs >= 60_000, 'Declared duration is invalid.');
  assert(Number.isSafeInteger(configuration.totalTimeoutMs)
    && configuration.totalTimeoutMs >= configuration.requestedDurationMs + 300_000,
    'Whole-run timeout does not preserve the required execution/cleanup reserve.');
  assert(Number.isSafeInteger(configuration.requestedActiveMs)
    && configuration.requestedActiveMs > 0
    && configuration.requestedActiveMs <= configuration.requestedDurationMs, 'Declared active duration is invalid.');
  assert(configuration.fixtureManifestId === manifest.id
    && configuration.fixtureManifestSha256 === sha256(manifestRaw), 'Fixture manifest identity mismatch.');
  assert(manifest.serviceClass === 'controlled-staging'
    && manifest.effectScope.publicInternet === false, 'Controlled evidence cannot be relabeled as genuine public-service evidence.');
  assert(trustedState.manifestVersion === manifest.version
    && /^[a-f0-9]{64}$/.test(trustedState.tokenSha256 ?? ''),
    'Trusted service policy or redacted credential identity is invalid.');
  assert(trustedAudit.every((event, index) => event.sequence === index + 1
    && Number.isFinite(event.at)), 'Trusted audit sequence is missing, duplicated or reordered.');
  const model = configuration.model;
  assert(model?.name && model?.id
    && (identity.mode !== 'live' || model.adapter === 'codex-cli'), 'Model identity is invalid.');

  const reportedChecks = report.checks ?? {};
  assert(Object.keys(reportedChecks).sort().join('|') === [...requiredChecks].sort().join('|'),
    'Criterion registry is missing or has unknown entries.');
  assert(report.external?.browser?.required === false
    && report.external.browser.verified === true,
    'Structured-tools evidence has an invalid browser claim.');

  const checkpoints = [];
  let previousRaw;
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    const checkpointRaw = await fs.readFile(
      path.join(root, 'checkpoints', String(sequence).padStart(4, '0') + '.json'),
      'utf8',
    );
    const checkpoint = JSON.parse(checkpointRaw);
    checkpoints.push(checkpoint);
    assert(checkpoint.schemaVersion === 1
      && checkpoint.sequence === sequence
      && checkpoint.runId === identity.runId
      && checkpoint.workspaceId === configuration.workspaceId
      && checkpoint.personaId === configuration.personaId
      && checkpoint.goalId === configuration.goalId, 'Checkpoint ' + sequence + ' identity mismatch.');
    assert(checkpoint.previousCheckpointSha256 === (previousRaw ? sha256(previousRaw) : null), 'Checkpoint hash chain is broken at sequence ' + sequence + '.');
    assert(validTime(checkpoint.createdAt)
      && validTime(checkpoint.processEpoch?.startedAt)
      && validTime(checkpoint.processEpoch?.endedAt), 'Checkpoint ' + sequence + ' timestamps are invalid.');
    previousRaw = checkpointRaw;
  }
  assert(checkpoints.map(value => value.phase).join('|')
    === 'bootstrap|crash-after-effect|recover', 'Unexpected process phase order.');
  assert(JSON.stringify(report.checkpoints?.map(value => value.sequence)) === '[1,2,3]', 'Report checkpoint registry is incomplete.');

  const epochs = report.processEpochs ?? [];
  assert(epochs.length === 3, 'Exactly three process epochs are required.');
  assert(new Set(epochs.map(epoch => epoch.epochId)).size === 3
    && new Set(epochs.map(epoch => epoch.pid)).size === 3
    && epochs.every(epoch => Number.isSafeInteger(epoch.pid) && epoch.pid > 0), 'OS process epochs do not prove three distinct processes.');
  assert(epochs.every(epoch => typeof epoch.processBirthMarker === 'string'
    && epoch.processBirthMarker.length > 0)
    && new Set(epochs.map(epoch => epoch.processBirthMarker)).size === 3, 'Process-birth markers do not prove distinct epochs.');
  assert(epochs.every(epoch => epoch.goalId === configuration.goalId), 'A process epoch changed the persisted goal identity.');
  assert(epochs.map(epoch => epoch.exitKind).join('|')
    === 'graceful|forced_after_effect|recovered_and_stopped', 'Process exit schedule mismatch.');
  assert(epochs[1].crashActivityId
    && epochs[1].postRestartActivityId
    && epochs[2].postRestartActivityId
    && epochs[2].postRestartActivityId !== epochs[1].crashActivityId, 'Post-restart Activity evidence is incomplete.');
  assert(JSON.stringify(epochs) === JSON.stringify(checkpoints.map(value => value.processEpoch)), 'Report epochs differ from immutable checkpoints.');

  const intervals = report.intervals ?? [];
  assert(intervals.length === 7, 'Expected active, downtime and scheduled-pause intervals are missing.');
  assert(intervals[0]?.startedAt === identity.startedAt
    && intervals.at(-1)?.endedAt === identity.endedAt, 'Interval coverage does not span the declared run.');
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index];
    assert(['active', 'downtime', 'paused'].includes(interval.kind)
      && validTime(interval.startedAt)
      && validTime(interval.endedAt)
      && intervalMs(interval) >= 0, 'Interval ' + index + ' is malformed.');
    if (index > 0) {
      assert(interval.startedAt === intervals[index - 1].endedAt, 'Clock gap or overlap before interval ' + index + '.');
    }
  }
  const activeDurationMs = intervals.filter(interval => interval.kind === 'active')
    .reduce((sum, interval) => sum + intervalMs(interval), 0);
  const pausedDurationMs = intervals.filter(interval => interval.kind === 'paused')
    .reduce((sum, interval) => sum + intervalMs(interval), 0);
  const downtimeDurationMs = intervals.filter(interval => interval.kind === 'downtime')
    .reduce((sum, interval) => sum + intervalMs(interval), 0);
  const elapsedDurationMs = Date.parse(identity.endedAt) - Date.parse(identity.startedAt);
  const metrics = report.metrics ?? {};
  assert(metrics.activeDurationMs === activeDurationMs
    && metrics.pausedDurationMs === pausedDurationMs
    && metrics.downtimeDurationMs === downtimeDurationMs
    && metrics.elapsedDurationMs === elapsedDurationMs, 'Duration metrics do not match the interval source records.');
  assert(elapsedDurationMs >= configuration.requestedDurationMs
    && activeDurationMs >= configuration.requestedActiveMs, 'Declared real-time duration was not observed.');

  assert(Number.isSafeInteger(metrics.eligibleRounds) && metrics.eligibleRounds > 0,
    'Eligible-round denominator is zero or invalid.');
  assert(Number.isSafeInteger(metrics.autonomousEligibleRounds)
    && metrics.autonomousEligibleRounds >= 0
    && metrics.autonomousEligibleRounds <= metrics.eligibleRounds,
    'Autonomous-round numerator is invalid.');
  assert(metrics.unattendedRoundRate === metrics.autonomousEligibleRounds / metrics.eligibleRounds,
    'Unattended rate does not match its numerator and denominator.');
  assert(Number.isSafeInteger(metrics.stalledDueButNeverAdmitted)
    && metrics.stalledDueButNeverAdmitted >= 0,
    'Stalled due work must be reported separately.');
  assert(Number.isSafeInteger(metrics.verifiedProgressActivities)
    && metrics.verifiedProgressActivities >= 3,
    'Insufficient independently linked useful progress.');

  const external = report.external ?? {};
  assert(external.serviceClass === 'controlled-staging'
    && external.serviceId === trustedState.serviceId
    && external.sourceId === trustedState.facts?.sourceId, 'External service/source identity mismatch.');
  assert(trustedState.effects?.length === 1
    && external.effects?.length === 1
    && JSON.stringify(external.effects[0]) === JSON.stringify(trustedState.effects[0]), 'Exactly one matching external effect is required.');
  assert(external.duplicateEffects === 0
    && !trustedAudit.some(event => event.type === 'duplicate_effect_prevented'), 'A duplicate or conflicting effect was observed.');
  assert(trustedState.acknowledgementState === 'reconciled'
    && external.acknowledgementState === 'reconciled', 'The lost acknowledgement was not reconciled by read-back.');
  assert(trustedAudit.some(event => event.type === 'publication_rate_limited')
    && trustedAudit.some(event => event.type === 'publication_committed_ack_withheld')
    && trustedAudit.some(event => event.type === 'publication_uncertain_effect_reconciled'), 'Required fault/recovery audit records are missing.');
  assert(trustedState.cleanup?.status === 'completed'
    && external.cleanup?.status === 'completed', 'External cleanup is incomplete.');
  assert(trustedAudit.some(event => event.type === 'publication_cleanup_completed'), 'Trusted cleanup audit is missing.');

  const agentRoot = path.join(root, 'agent-workspace');
  for (const name of ['research.md', 'launch.md', 'backlog.md']) {
    const content = await fs.readFile(path.join(agentRoot, name), 'utf8').catch(() => '');
    const observed = trustedState.artifacts?.[name];
    assert(verifiedContent(content, trustedState.facts)
      && observed?.verified === true
      && observed.sha256 === sha256(content), 'Artifact ' + name + ' is missing, stale or not independently verified.');
  }
  assert(trustedState.effects[0]?.contentSha256
    === trustedState.artifacts?.['launch.md']?.sha256, 'Publication read-back hash does not match launch.md.');
  assert(path.relative(agentRoot, path.join(root, 'trusted-verifier')).startsWith('..'), 'Trusted verifier evidence is inside the model-writable campaign root.');

  const activities = report.activities ?? [];
  assert(Array.isArray(activities)
    && activities.some(activity => activity.id === epochs[1].crashActivityId)
    && activities.some(activity => activity.id === epochs[2].postRestartActivityId), 'Persisted Activity evidence does not match process checkpoints.');
  assert(report.recovery?.postCrashActivityIds?.includes(epochs[2].postRestartActivityId)
    && !report.recovery.postCrashActivityIds.includes(epochs[1].crashActivityId), 'Unsafe replay or missing fresh post-crash admission.');
  const runtimeTurns = runtimeModelTurns.records ?? [];
  const completedRuntimeTurns = runtimeTurns.filter(turn => turn.outcome === 'completed');
  const expectedEpochIds = new Set(epochs.map(epoch => epoch.epochId));
  const actualModelObserved = runtimeModelTurns.schemaVersion === 1
    && runtimeModelTurns.runId === identity.runId
    && runtimeModelTurns.sourceRoot === 'runtime-data/db/model-turns'
    && runtimeTurns.length > 0
    && runtimeTurns.length <= configuration.maxModelCalls
    && runtimeTurns.every(turn =>
      typeof turn.id === 'string'
      && typeof turn.conversationId === 'string'
      && turn.modelId === model.id
      && turn.adapter === model.adapter
      && turn.source === 'runtime-model-turn-archive'
      && /^[a-f0-9]{64}$/.test(turn.sourceFileSha256 ?? '')
      && expectedEpochIds.has(turn.processEpochId)
      && epochs.some(epoch => epoch.epochId === turn.processEpochId
        && epoch.pid === turn.processPid
        && turn.timestamp >= Date.parse(epoch.startedAt)
        && turn.timestamp <= Date.parse(epoch.endedAt)))
    && new Set(completedRuntimeTurns.map(turn => turn.processEpochId)).size === 3
    && (identity.mode !== 'live' || completedRuntimeTurns.every(turn =>
      turn.operation === 'thread.runStreamed'
      && turn.adapter === 'codex-cli'));
  assert(actualModelObserved,
    'Runtime-owned model dispatch archives are invalid, exceed the limit, or do not span all process epochs.');
  const goals = report.goals ?? [];
  assert(goals.length === 1
    && goals[0].id === configuration.goalId
    && goals[0].goal?.completionPolicy === 'until_stopped'
    && goals[0].goal?.state === 'stopped'
    && goals[0].goal?.pendingControlId === undefined,
  'Exactly one owner-stopped ongoing goal with no unresolved control outbox is required.');
  const mailbox = report.mailbox ?? [];
  const persistedEventEvidence = runtimeProvenance.runtimeEvents ?? [];
  const persistedDispatchEvidence = runtimeProvenance.dispatches ?? [];
  const runtimeEvents = persistedEventEvidence.map(value => value.record);
  const dispatches = persistedDispatchEvidence.map(value => value.record);
  assert(runtimeProvenance.schemaVersion === 1
    && runtimeProvenance.runId === identity.runId
    && runtimeProvenance.sourceRoot === 'runtime-data'
    && validTime(runtimeProvenance.collectedAt),
    'Parent-collected runtime provenance identity is invalid.');
  assert([...persistedEventEvidence, ...persistedDispatchEvidence].every(value =>
    typeof value.source === 'string'
      && value.source.length > 0
      && /^[a-f0-9]{64}$/.test(value.sourceFileSha256 ?? '')),
  'Runtime provenance lacks persisted source receipts.');
  const reportedRuntimeEvents = [...(report.runtimeEvents ?? [])]
    .sort((left, right) => left.seq - right.seq);
  const reportedDispatches = [...(report.dispatches ?? [])]
    .sort((left, right) => left.id.localeCompare(right.id));
  assert(stableJson(runtimeEvents) === stableJson(reportedRuntimeEvents)
    && stableJson(dispatches) === stableJson(reportedDispatches),
  'Producer runtime records differ from the parent-collected persisted source.');
  assert(Array.isArray(runtimeEvents) && runtimeEvents.length > 0
    && runtimeEvents.every((event, index) => Number.isSafeInteger(event.seq)
      && (index === 0 || event.seq === runtimeEvents[index - 1].seq + 1)),
    'Runtime event sequence is missing, duplicated or discontinuous.');
  const goalControlEvents = runtimeEvents
    .filter(event => event.type === 'goal:control' && event.goalId === configuration.goalId);
  const goalRoundEvents = runtimeEvents
    .filter(event => event.type === 'goal:round' && event.goalId === configuration.goalId);
  const mailboxById = new Map(mailbox.map(item => [item.id, item]));
  const activityById = new Map(activities.map(activity => [activity.id, activity]));
  const dispatchById = new Map(dispatches.map(dispatch => [dispatch.id, dispatch]));
  const controlById = new Map(goalControlEvents.map(event => [event.controlId, event]));
  const stopControlEvent = goalControlEvents.find(event => event.action === 'stop');
  assert(new Set(runtimeEvents.map(event => event.eventId)).size === runtimeEvents.length
    && new Set(dispatches.map(dispatch => dispatch.id)).size === dispatches.length,
  'Runtime provenance contains duplicate event or dispatch identities.');
  for (const dispatch of dispatches) {
    if (!dispatch.cancellationControlId) continue;
    const control = controlById.get(dispatch.cancellationControlId);
    assert((control?.action === 'pause' || control?.action === 'stop')
      && Number.isFinite(dispatch.cancellationRequestedAt)
      && dispatch.cancellationRequestedAt >= control.appliedAt,
    'A dispatch cancellation has invalid owner-control causality.');
  }
  for (const event of goalRoundEvents) {
    const dispatch = dispatchById.get(event.dispatchId);
    const retryControl = event.controlId ? controlById.get(event.controlId) : undefined;
    assert(dispatch?.id === event.dispatchId
      && dispatch.workspaceId === configuration.workspaceId
      && dispatch.personaId === configuration.personaId
      && dispatch.admission?.kind === 'assignment'
      && dispatch.admission.source?.sourceId === event.taskId
      && dispatch.idempotencyDigest === sha256(event.attemptKey),
    'A goal round does not match its durable dispatch identity and admission source.');
    assert(event.cause === 'manual_retry'
      ? retryControl?.action === 'retry' && retryControl.seq < event.seq
      : event.cause === 'autonomous' && event.controlId === undefined,
    'A goal round has invalid owner-control attribution or event ordering.');
  }
  const roundAdmissions = goalRoundEvents.map(event => {
    const dispatch = dispatchById.get(event.dispatchId);
    const mailboxItem = dispatch?.mailboxItemId
      ? mailboxById.get(dispatch.mailboxItemId)
      : undefined;
    const activityId = dispatch?.activityId
      && mailboxItem?.claimedActivityId === dispatch.activityId
      && activityById.has(dispatch.activityId)
      ? dispatch.activityId
      : undefined;
    return {
      eventId: event.eventId,
      eventSeq: event.seq,
      goalId: event.goalId,
      round: event.round,
      attemptKey: event.attemptKey,
      cause: event.cause,
      controlId: event.controlId,
      dueAt: event.dueAt,
      reservedAt: event.reservedAt,
      dispatchId: event.dispatchId,
      dispatchState: dispatch?.state ?? 'missing',
      mailboxItemId: mailboxItem?.id,
      activityId,
      ownerCancelledBeforeDispatch: !activityId
        && dispatch?.state === 'cancelled'
        && dispatch.cancellationControlId === stopControlEvent?.controlId
        && (dispatch.cancellationRequestedAt ?? -1) >= (stopControlEvent?.appliedAt ?? Infinity)
        && dispatch.cancellationReason === 'The ongoing goal was stopped.',
    };
  });
  assert(JSON.stringify(roundAdmissions) === JSON.stringify(report.goalRoundAdmissions),
    'Round admission report does not match durable event/dispatch/mailbox provenance.');
  const eligibleRoundAdmissions = roundAdmissions.filter(value => value.activityId);
  const eligibleActivityIds = new Set(eligibleRoundAdmissions.map(value => value.activityId));
  const autonomousEligibleRounds = eligibleRoundAdmissions
    .filter(value => value.cause === 'autonomous').length;
  const stalledDueButNeverAdmitted = roundAdmissions.filter(value =>
    value.dueAt <= Date.parse(identity.endedAt)
    && !value.activityId
    && !value.ownerCancelledBeforeDispatch).length;
  assert(metrics.eligibleRounds === eligibleRoundAdmissions.length,
    'Eligible-round denominator does not match durable round admissions.');
  assert(metrics.autonomousEligibleRounds === autonomousEligibleRounds,
    'Autonomous-round numerator does not match durable round causes.');
  assert(metrics.stalledDueButNeverAdmitted === stalledDueButNeverAdmitted,
    'Stalled due work does not match durable reservation/admission evidence.');

  const scheduledControls = goalControlEvents.map(event => ({
    controlId: event.controlId,
    goalId: event.goalId,
    action: event.action,
    classification: 'scheduled',
    requestedAt: new Date(event.requestedAt).toISOString(),
    appliedAt: new Date(event.appliedAt).toISOString(),
    fromState: event.fromState,
    resultingState: event.toState,
    attributedActivityId: event.action === 'retry'
      ? roundAdmissions.find(round => round.controlId === event.controlId)?.activityId
      : undefined,
    eventSeq: event.seq,
  }));
  const checkpointControls = checkpoints[2].observations?.scheduledControls ?? [];
  const reportControls = (report.interventions ?? []).filter(value => value.controlId);
  const retryControl = scheduledControls.find(value => value.action === 'retry');
  const unscheduledInterventionCount = (report.interventions ?? [])
    .filter(value => value.classification === 'unscheduled').length;
  const noUnscheduledIntervention = mailbox.every(item => item.source?.kind !== 'chat')
    && goals.every(goal => goal.goal?.state !== 'needs_input' && !goal.goal?.interventionReason)
    && unscheduledInterventionCount === 0;
  assert(metrics.interventionCount === report.interventions?.length
    && metrics.unscheduledInterventionCount === unscheduledInterventionCount,
    'Intervention accounting is incomplete.');
  assert(noUnscheduledIntervention,
    'Unscheduled human input or intervention request is present in persisted evidence.');
  const controlHistoryValid = scheduledControls.length === 3
    && JSON.stringify(scheduledControls) === JSON.stringify(checkpointControls)
    && JSON.stringify(scheduledControls) === JSON.stringify(reportControls)
    && scheduledControls.map(value => value.action).join('|') === 'pause|retry|stop'
    && scheduledControls.map(value => value.fromState).join('|') === 'active|paused|active'
    && scheduledControls.map(value => value.resultingState).join('|') === 'paused|active|stopped'
    && scheduledControls.every(value => Date.parse(value.appliedAt) >= Date.parse(value.requestedAt))
    && retryControl?.attributedActivityId
    && eligibleActivityIds.has(retryControl.attributedActivityId)
    && roundAdmissions.some(round => round.controlId === retryControl.controlId
      && round.cause === 'manual_retry'
      && round.activityId === retryControl.attributedActivityId)
    && scheduledControls[0].appliedAt === intervals[4]?.endedAt
    && scheduledControls[1].appliedAt === intervals[5]?.endedAt
    && scheduledControls[2].appliedAt === identity.endedAt;
  const verifiedTimes = [
    ...Object.values(trustedState.artifacts ?? {}).map(artifact => artifact.observedAt),
    ...trustedState.effects.map(effectRecord => effectRecord.publishedAt),
  ];
  const independentlyLinkedActivities = new Set(verifiedTimes.flatMap(observedAt =>
    activities.filter(activity => activity.createdAt <= observedAt
      && (activity.completedAt ?? Date.parse(identity.endedAt)) >= observedAt)
      .map(activity => activity.id)));
  assert(independentlyLinkedActivities.size === metrics.verifiedProgressActivities,
    'Verified-progress count does not match trusted observation times and persisted Activities.');

  const independentlyDerivedChecks = {
    oneOngoingGoal: goals.length === 1
      && goals[0].id === configuration.goalId
      && goals[0].goal?.completionPolicy === 'until_stopped',
    ordinaryMarketingSetup: configuration.roleName === 'Marketing Agent'
      && configuration.personaName === 'Frederik'
      && configuration.initialGoal === 'Make FLUJO known on the internet'
      && Array.isArray(checkpoints[0].observations?.initialAgentEntries)
      && checkpoints[0].observations.initialAgentEntries.length === 0,
    multipleAutonomousWakeups: autonomousEligibleRounds >= 4,
    gracefulProcessRestart: epochs[0]?.exitKind === 'graceful'
      && epochs[0]?.pid !== epochs[1]?.pid
      && Boolean(epochs[1]?.postRestartActivityId),
    forcedProcessRecovery: epochs[1]?.exitKind === 'forced_after_effect'
      && new Set(epochs.map(epoch => epoch.pid)).size === 3
      && new Set(epochs.map(epoch => epoch.processBirthMarker)).size === 3
      && report.recovery?.postCrashActivityIds?.includes(epochs[2]?.postRestartActivityId)
      && !report.recovery?.postCrashActivityIds?.includes(epochs[1]?.crashActivityId),
    effectReconciliation: trustedState.effects?.length === 1
      && external.effects?.length === 1
      && trustedState.acknowledgementState === 'reconciled'
      && external.duplicateEffects === 0
      && trustedAudit.some(event => event.type === 'publication_uncertain_effect_reconciled'),
    verifiedUsefulProgress: independentlyLinkedActivities.size >= 3
      && ['research.md', 'launch.md', 'backlog.md']
        .every(name => trustedState.artifacts?.[name]?.verified === true),
    recoverableFailureContinuation: trustedAudit.some(event => event.type === 'publication_rate_limited')
      && trustedAudit.some(event => event.type === 'publication_committed_ack_withheld')
      && trustedAudit.some(event => event.type === 'publication_uncertain_effect_reconciled'),
    ownerControlsPersisted: Boolean(controlHistoryValid)
      && goals[0]?.goal?.state === 'stopped',
    noUnscheduledIntervention,
    durationSatisfied: elapsedDurationMs >= configuration.requestedDurationMs
      && activeDurationMs >= configuration.requestedActiveMs,
    cleanupCompleted: trustedState.cleanup?.status === 'completed'
      && external.cleanup?.status === 'completed'
      && trustedAudit.some(event => event.type === 'publication_cleanup_completed'),
    browserExecution: external.browser?.required === false
      && external.browser?.verified === true,
    actualModelObserved,
  };
  assert(requiredChecks.every(id => independentlyDerivedChecks[id] === true),
    'At least one independently recomputed endurance criterion did not pass.');
  assert(requiredChecks.every(id => reportedChecks[id] === independentlyDerivedChecks[id]),
    'Producer-authored criterion results differ from independently recomputed evidence.');
  assert(report.qualityReview?.status === 'not_evaluated'
    && report.qualityReview?.rubricVersion, 'Quality must remain separate from autonomy evidence.');

  const expectedChecksumLines = [];
  for (const filename of ENDURANCE_EVIDENCE_FILES) {
    expectedChecksumLines.push(sha256(await fs.readFile(path.join(root, filename))) + '  ' + filename);
  }
  assert(checksumRaw === expectedChecksumLines.join('\n') + '\n', 'Evidence checksum manifest mismatch.');
  assert(raw.endsWith('\n') && runtimeModelTurnsRaw.endsWith('\n')
    && runtimeProvenanceRaw.endsWith('\n')
    && trustedStateRaw.endsWith('\n') && manifestRaw.endsWith('\n'),
    'Evidence text files must end with a newline.');
  if (errors.length) {
    throw new Error('Persona goal endurance validation failed:\n- ' + errors.join('\n- '));
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const values = new Map();
  for (const argument of process.argv.slice(2)) {
    const match = /^--(directory|commit|mode|profile|source-diff|attestation-key-sha256)=(.+)$/.exec(argument);
    if (!match || values.has(match[1])) throw new Error('Invalid or duplicate argument: ' + argument);
    values.set(match[1], match[2]);
  }
  for (const required of ['directory', 'commit', 'mode', 'profile', 'source-diff', 'attestation-key-sha256']) {
    if (!values.get(required)) throw new Error('--' + required + ' is required.');
  }
  await validatePersonaGoalEndurance({
    directory: path.resolve(values.get('directory')),
    expectedCommit: values.get('commit'),
    expectedMode: values.get('mode'),
    expectedProfile: values.get('profile'),
    expectedSourceDiffSha256: values.get('source-diff'),
    expectedAttestationKeySha256: values.get('attestation-key-sha256'),
  });
  process.stdout.write('Validated Persona goal endurance against checkpoints, runtime records and trusted external effects.\n');
}
