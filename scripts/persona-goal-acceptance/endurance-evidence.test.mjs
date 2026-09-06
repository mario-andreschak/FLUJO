import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ENDURANCE_EVIDENCE_FILES,
  enduranceAttestationKeySha256,
  writeEnduranceEvidenceAttestation,
} from './endurance-attestation.mjs';
import { CONTROLLED_PUBLIC_FIXTURE_MANIFEST } from './public-fixture-manifest.mjs';
import { validatePersonaGoalEndurance } from '../validate-persona-goal-endurance.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const iso = seconds => new Date(Date.parse('2026-09-06T00:00:00.000Z') + seconds * 1000).toISOString();
const checks = Object.fromEntries([
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
].map(id => [id, true]));


async function writeChecksums(root) {
  const lines = [];
  for (const filename of ENDURANCE_EVIDENCE_FILES) {
    lines.push(sha256(await readFile(path.join(root, filename))) + '  ' + filename);
  }
  await writeFile(path.join(root, 'SHA256SUMS'), lines.join('\n') + '\n');
}

async function writeReport(root, report, keys) {
  await writeFile(
    path.join(root, 'persona-goal-endurance.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeEnduranceEvidenceAttestation({
    directory: root,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    runId: report.runIdentity.runId,
    commitSha: report.runIdentity.commitSha,
    sourceDiffSha256: report.runIdentity.sourceDiffSha256,
  });
}

async function writeSyntheticRuntimeProvenance(root, report) {
  await writeFile(
    path.join(root, 'runtime-provenance.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId: report.runIdentity.runId,
      collectedAt: iso(61),
      sourceRoot: 'runtime-data',
      runtimeEvents: report.runtimeEvents.map(event => ({
        record: event,
        source: 'db/persona-runtime-events/events.jsonl',
        sourceFileSha256: 'c'.repeat(64),
      })),
      dispatches: [...report.dispatches]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(dispatch => ({
          record: dispatch,
          source: 'db/persona-flow-dispatches/' + dispatch.id + '.json',
          sourceFileSha256: 'd'.repeat(64),
        })),
    }, null, 2) + '\n',
  );
}

async function createSyntheticEvidence(root) {
  await Promise.all([
    mkdir(path.join(root, 'agent-workspace'), { recursive: true }),
    mkdir(path.join(root, 'checkpoints'), { recursive: true }),
    mkdir(path.join(root, 'trusted-verifier'), { recursive: true }),
  ]);
  const facts = {
    sourceId: 'endurance-research-unit',
    audience: 'independent automation teams unit',
    benefit: 'sustain verified marketing progress across failures unit',
  };
  const contents = {
    'research.md': '# Research\nSource: ' + facts.sourceId + '\nAudience: ' + facts.audience
      + '\nBenefit: ' + facts.benefit + '\nAccurate product research and examples.',
    'launch.md': '# Launch\nSource: ' + facts.sourceId + '\nAudience: ' + facts.audience
      + '\nBenefit: ' + facts.benefit + '\nUseful controlled launch material and examples.',
    'backlog.md': '# Backlog\nSource: ' + facts.sourceId + '\nAudience: ' + facts.audience
      + '\nBenefit: ' + facts.benefit + '\nMeasure, research and iterate useful follow-up work.',
  };
  for (const [name, value] of Object.entries(contents)) {
    await writeFile(path.join(root, 'agent-workspace', name), value);
  }
  const manifestRaw = JSON.stringify(CONTROLLED_PUBLIC_FIXTURE_MANIFEST, null, 2) + '\n';
  await writeFile(path.join(root, 'trusted-verifier', 'manifest.json'), manifestRaw);
  const artifactTimes = { 'research.md': 5, 'launch.md': 15, 'backlog.md': 35 };
  const artifacts = Object.fromEntries(Object.entries(contents).map(([name, value]) => [
    name,
    { name, sha256: sha256(value), observedAt: Date.parse(iso(artifactTimes[name])), verified: true },
  ]));
  const effect = {
    id: 'controlled-publication-unit',
    serviceId: CONTROLLED_PUBLIC_FIXTURE_MANIFEST.id,
    idempotencyKey: 'goal-endurance-publication:unit-run',
    sourceId: facts.sourceId,
    contentSha256: artifacts['launch.md'].sha256,
    publishedAt: Date.parse(iso(25)),
    readbackUrl: '/publication',
  };
  const trustedState = {
    schemaVersion: 1,
    runId: 'unit-run',
    serviceId: CONTROLLED_PUBLIC_FIXTURE_MANIFEST.id,
    manifestVersion: CONTROLLED_PUBLIC_FIXTURE_MANIFEST.version,
    tokenSha256: sha256('unit-test-ephemeral-token'),
    facts,
    artifacts,
    publicationAttempts: 2,
    effects: [effect],
    acknowledgementState: 'reconciled',
    cleanup: { required: true, status: 'completed', publicationId: effect.id, completedAt: Date.parse(iso(59)) },
  };
  await writeFile(
    path.join(root, 'trusted-verifier', 'state.json'),
    JSON.stringify(trustedState, null, 2) + '\n',
  );
  const audit = [
    { sequence: 1, at: Date.parse(iso(20)), type: 'publication_rate_limited' },
    { sequence: 2, at: Date.parse(iso(25)), type: 'publication_committed_ack_withheld' },
    { sequence: 3, at: Date.parse(iso(35)), type: 'publication_uncertain_effect_reconciled' },
    { sequence: 4, at: Date.parse(iso(59)), type: 'publication_cleanup_completed' },
  ];
  await writeFile(
    path.join(root, 'trusted-verifier', 'audit.jsonl'),
    audit.map(value => JSON.stringify(value)).join('\n') + '\n',
  );
  const scheduledControls = [
    {
      controlId: 'goalcontrol-pause-unit', goalId: 'goal-unit', action: 'pause',
      classification: 'scheduled', requestedAt: iso(40), appliedAt: iso(40),
      fromState: 'active', resultingState: 'paused', eventSeq: 4,
    },
    {
      controlId: 'goalcontrol-retry-unit', goalId: 'goal-unit', action: 'retry',
      classification: 'scheduled', requestedAt: iso(45), appliedAt: iso(45),
      fromState: 'paused', resultingState: 'active',
      attributedActivityId: 'activity-followup', eventSeq: 5,
    },
    {
      controlId: 'goalcontrol-stop-unit', goalId: 'goal-unit', action: 'stop',
      classification: 'scheduled', requestedAt: iso(60), appliedAt: iso(60),
      fromState: 'active', resultingState: 'stopped', eventSeq: 7,
    },
  ];
  const checkpointValues = [
    {
      phase: 'bootstrap',
      epoch: {
        epochId: 'epoch-1-graceful',
        pid: 1001,
        processBirthMarker: 'v2:unit:1',
        startedAt: iso(0),
        endedAt: iso(10),
        exitKind: 'graceful',
        goalId: 'goal-unit',
      },
      calls: [{
        model: 'offline-endurance-fixture', adapter: 'openai', pid: 1001,
        outcome: 'completed', completionId: 'offline-unit-1', usage: { total_tokens: 2 },
      }],
      observations: { initialAgentEntries: [] },
    },
    {
      phase: 'crash-after-effect',
      epoch: {
        epochId: 'epoch-2-forced',
        pid: 1002,
        processBirthMarker: 'v2:unit:2',
        startedAt: iso(12),
        endedAt: iso(30),
        exitKind: 'forced_after_effect',
        goalId: 'goal-unit',
        postRestartActivityId: 'activity-launch',
        crashActivityId: 'activity-crash',
      },
      calls: [{
        model: 'offline-endurance-fixture', adapter: 'openai', pid: 1002,
        outcome: 'completed', completionId: 'offline-unit-2', usage: { total_tokens: 2 },
      }],
      observations: {},
    },
    {
      phase: 'recover',
      epoch: {
        epochId: 'epoch-3-recovered',
        pid: 1003,
        processBirthMarker: 'v2:unit:3',
        startedAt: iso(32),
        endedAt: iso(60),
        exitKind: 'recovered_and_stopped',
        goalId: 'goal-unit',
        postRestartActivityId: 'activity-recovered',
      },
      calls: [{
        model: 'offline-endurance-fixture', adapter: 'openai', pid: 1003,
        outcome: 'completed', completionId: 'offline-unit-3', usage: { total_tokens: 2 },
      }],
      observations: { scheduledControls },
    },
  ];
  const checkpointRecords = [];
  let previousRaw;
  for (let index = 0; index < checkpointValues.length; index += 1) {
    const value = checkpointValues[index];
    const record = {
      schemaVersion: 1,
      sequence: index + 1,
      phase: value.phase,
      runId: 'unit-run',
      previousCheckpointSha256: previousRaw ? sha256(previousRaw) : null,
      createdAt: value.epoch.endedAt,
      processEpoch: value.epoch,
      workspaceId: 'workspace-unit',
      personaId: 'persona-unit',
      goalId: 'goal-unit',
      roleVersionId: 'role-unit',
      modelCalls: value.calls,
      observations: value.observations,
    };
    const raw = JSON.stringify(record, null, 2) + '\n';
    await writeFile(
      path.join(root, 'checkpoints', String(index + 1).padStart(4, '0') + '.json'),
      raw,
    );
    checkpointRecords.push(record);
    previousRaw = raw;
  }
  const intervals = [
    { kind: 'active', startedAt: iso(0), endedAt: iso(10), epochId: 'epoch-1-graceful' },
    { kind: 'downtime', startedAt: iso(10), endedAt: iso(12) },
    { kind: 'active', startedAt: iso(12), endedAt: iso(30), epochId: 'epoch-2-forced' },
    { kind: 'downtime', startedAt: iso(30), endedAt: iso(32) },
    { kind: 'active', startedAt: iso(32), endedAt: iso(40), epochId: 'epoch-3-recovered' },
    { kind: 'paused', startedAt: iso(40), endedAt: iso(45), control: 'scheduled-pause' },
    { kind: 'active', startedAt: iso(45), endedAt: iso(60), epochId: 'epoch-3-recovered' },
  ];
  const model = { id: 'goal-endurance-model', name: 'offline-endurance-fixture', adapter: 'openai' };
  const activities = [
    { id: 'activity-research', createdAt: Date.parse(iso(1)), completedAt: Date.parse(iso(8)) },
    { id: 'activity-launch', createdAt: Date.parse(iso(13)), completedAt: Date.parse(iso(18)) },
    { id: 'activity-crash', createdAt: Date.parse(iso(20)), completedAt: Date.parse(iso(34)) },
    { id: 'activity-recovered', createdAt: Date.parse(iso(34)), completedAt: Date.parse(iso(39)) },
    { id: 'activity-followup', createdAt: Date.parse(iso(46)), completedAt: Date.parse(iso(55)) },
  ];
  const mailbox = activities.map((activity, index) => ({
    id: 'mailbox-' + index,
    claimedActivityId: activity.id,
    source: { kind: 'assignment', sourceId: 'goal-unit' },
  }));
  const dispatches = activities.map((activity, index) => ({
    id: 'dispatch-' + (index + 1),
    schemaVersion: 1,
    workspaceId: 'workspace-unit',
    personaId: 'persona-unit',
    idempotencyDigest: sha256('round-attempt-' + (index + 1)),
    requestHash: String(index + 1).repeat(64),
    state: 'completed',
    admission: {
      kind: 'assignment',
      source: { kind: 'assignment', sourceId: 'goal-unit' },
    },
    mailboxItemId: mailbox[index].id,
    activityId: activity.id,
  }));
  const runtimeEvents = [
    { type: 'goal:round', eventId: 'round-event-1', seq: 0, timestamp: Date.parse(iso(1)),
      version: 1, workspaceId: 'workspace-unit', personaId: 'persona-unit', goalId: 'goal-unit',
      round: 1, attemptKey: 'round-attempt-1', taskId: 'goal-unit', cause: 'autonomous',
      dueAt: Date.parse(iso(0)), reservedAt: Date.parse(iso(1)), dispatchId: 'dispatch-1' },
    { type: 'goal:round', eventId: 'round-event-2', seq: 1, timestamp: Date.parse(iso(13)),
      version: 1, workspaceId: 'workspace-unit', personaId: 'persona-unit', goalId: 'goal-unit',
      round: 2, attemptKey: 'round-attempt-2', taskId: 'goal-unit', cause: 'autonomous',
      dueAt: Date.parse(iso(12)), reservedAt: Date.parse(iso(13)), dispatchId: 'dispatch-2' },
    { type: 'goal:round', eventId: 'round-event-3', seq: 2, timestamp: Date.parse(iso(20)),
      version: 1, workspaceId: 'workspace-unit', personaId: 'persona-unit', goalId: 'goal-unit',
      round: 3, attemptKey: 'round-attempt-3', taskId: 'goal-unit', cause: 'autonomous',
      dueAt: Date.parse(iso(19)), reservedAt: Date.parse(iso(20)), dispatchId: 'dispatch-3' },
    { type: 'goal:round', eventId: 'round-event-4', seq: 3, timestamp: Date.parse(iso(34)),
      version: 1, workspaceId: 'workspace-unit', personaId: 'persona-unit', goalId: 'goal-unit',
      round: 4, attemptKey: 'round-attempt-4', taskId: 'goal-unit', cause: 'autonomous',
      dueAt: Date.parse(iso(33)), reservedAt: Date.parse(iso(34)), dispatchId: 'dispatch-4' },
    { type: 'goal:control', eventId: 'goalcontrol-pause-unit', seq: 4,
      timestamp: Date.parse(iso(40)), version: 1, workspaceId: 'workspace-unit', personaId: 'persona-unit',
      goalId: 'goal-unit', controlId: 'goalcontrol-pause-unit', action: 'pause',
      fromState: 'active', toState: 'paused', requestedAt: Date.parse(iso(40)), appliedAt: Date.parse(iso(40)) },
    { type: 'goal:control', eventId: 'goalcontrol-retry-unit', seq: 5,
      timestamp: Date.parse(iso(45)), version: 1, workspaceId: 'workspace-unit', personaId: 'persona-unit',
      goalId: 'goal-unit', controlId: 'goalcontrol-retry-unit', action: 'retry',
      fromState: 'paused', toState: 'active', requestedAt: Date.parse(iso(45)), appliedAt: Date.parse(iso(45)) },
    { type: 'goal:round', eventId: 'round-event-5', seq: 6, timestamp: Date.parse(iso(46)),
      version: 1, workspaceId: 'workspace-unit', personaId: 'persona-unit', goalId: 'goal-unit',
      round: 5, attemptKey: 'round-attempt-5', taskId: 'goal-unit', cause: 'manual_retry',
      controlId: 'goalcontrol-retry-unit', dueAt: Date.parse(iso(45)),
      reservedAt: Date.parse(iso(46)), dispatchId: 'dispatch-5' },
    { type: 'goal:control', eventId: 'goalcontrol-stop-unit', seq: 7,
      timestamp: Date.parse(iso(60)), version: 1, workspaceId: 'workspace-unit', personaId: 'persona-unit',
      goalId: 'goal-unit', controlId: 'goalcontrol-stop-unit', action: 'stop',
      fromState: 'active', toState: 'stopped', requestedAt: Date.parse(iso(60)), appliedAt: Date.parse(iso(60)) },
  ];
  const goalRoundAdmissions = runtimeEvents.filter(event => event.type === 'goal:round')
    .map(event => {
      const dispatch = dispatches.find(value => value.id === event.dispatchId);
      const mailboxItem = mailbox.find(value => value.id === dispatch?.mailboxItemId);
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
        activityId: dispatch?.activityId,
        ownerCancelledBeforeDispatch: false,
      };
    });
  const report = {
    schemaVersion: 1,
    status: 'completed',
    runIdentity: {
      runId: 'unit-run',
      commitSha: 'a'.repeat(40),
      sourceDiffSha256: 'b'.repeat(64),
      mode: 'offline',
      profile: 'structured-tools',
      authoritativeLiveModel: false,
      startedAt: iso(0),
      endedAt: iso(60),
      verifierVersion: 'persona-goal-endurance-v1',
      policyVersion: 'issue-505-endurance-metrics-v1',
    },
    configuration: {
      model,
      workspaceId: 'workspace-unit',
      personaId: 'persona-unit',
      goalId: 'goal-unit',
      roleVersionId: 'role-unit',
      roleName: 'Marketing Agent',
      personaName: 'Frederik',
      initialGoal: 'Make FLUJO known on the internet',
      completionPolicy: 'until_stopped',
      requestedDurationMs: 60_000,
      requestedActiveMs: 50_000,
      pauseMs: 5_000,
      continuationIntervalMs: 1_000,
      roundLimit: 20,
      maxModelCalls: 100,
      totalTimeoutMs: 360_000,
      concurrency: 1,
      budgetUsd: 0,
      fixtureManifestId: CONTROLLED_PUBLIC_FIXTURE_MANIFEST.id,
      fixtureManifestSha256: sha256(manifestRaw),
    },
    checks,
    processEpochs: checkpointRecords.map(value => value.processEpoch),
    intervals,
    checkpoints: checkpointRecords.map(value => ({
      sequence: value.sequence,
      phase: value.phase,
      filename: 'checkpoints/' + String(value.sequence).padStart(4, '0') + '.json',
    })),
    metrics: {
      eligibleRounds: 5,
      autonomousEligibleRounds: 4,
      unattendedRoundRate: 0.8,
      stalledDueButNeverAdmitted: 0,
      interventionCount: 6,
      unscheduledInterventionCount: 0,
      verifiedProgressActivities: 4,
      elapsedDurationMs: 60_000,
      activeDurationMs: 51_000,
      pausedDurationMs: 5_000,
      downtimeDurationMs: 4_000,
    },
    interventions: [
      { type: 'initial_setup', classification: 'initial_setup', at: iso(0) },
      { type: 'graceful_restart', classification: 'scheduled', at: iso(10) },
      { type: 'forced_termination', classification: 'scheduled', at: iso(30) },
      ...scheduledControls,
    ],
    recovery: {
      postCrashActivityIds: ['activity-recovered'],
      crashActivityId: 'activity-crash',
    },
    external: {
      serviceClass: 'controlled-staging',
      serviceId: trustedState.serviceId,
      sourceId: facts.sourceId,
      artifacts,
      effects: [effect],
      publicationAttempts: 2,
      duplicateEffects: 0,
      acknowledgementState: 'reconciled',
      cleanup: trustedState.cleanup,
      browser: { required: false, verified: true, launches: 0, reads: 0 },
    },
    qualityReview: {
      status: 'not_evaluated',
      rubricVersion: 'marketing-output-quality-v1',
      reason: 'Independent review is separate.',
    },
    goals: [{
      id: 'goal-unit',
      goal: { state: 'stopped', completionPolicy: 'until_stopped' },
    }],
    activities,
    goalTasks: [],
    mailbox,
    dispatches,
    runtimeEvents,
    goalRoundAdmissions,
    modelCalls: checkpointValues.flatMap(value => value.calls),
  };
  await writeFile(
    path.join(root, 'runtime-model-turns.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId: 'unit-run',
      collectedAt: iso(61),
      sourceRoot: 'runtime-data/db/model-turns',
      records: checkpointRecords.map((checkpoint, index) => ({
        id: 'runtime-model-turn-' + (index + 1),
        conversationId: 'conversation-' + (index + 1),
        runId: 'activity-run-' + (index + 1),
        modelId: model.id,
        modelName: 'Goal endurance model',
        adapter: model.adapter,
        operation: 'offline-fixture.createCompletion',
        timestamp: Date.parse(iso([2, 15, 35][index])),
        outcome: 'completed',
        source: 'runtime-model-turn-archive',
        sourceFileSha256: String(index + 1).repeat(64),
        processEpochId: checkpoint.processEpoch.epochId,
        processPid: checkpoint.processEpoch.pid,
      })),
    }, null, 2) + '\n',
  );
  await writeSyntheticRuntimeProvenance(root, report);
  const keys = generateKeyPairSync('ed25519');
  const expectedAttestationKeySha256 = enduranceAttestationKeySha256(keys.publicKey);
  await writeReport(root, report, keys);
  return { report, keys, expectedAttestationKeySha256 };
}

const validationOptions = (directory, expectedAttestationKeySha256) => ({
  directory,
  expectedCommit: 'a'.repeat(40),
  expectedMode: 'offline',
  expectedProfile: 'structured-tools',
  expectedSourceDiffSha256: 'b'.repeat(64),
  expectedAttestationKeySha256,
});

test('validates chained endurance evidence and rejects semantic tampering', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'flujo-goal-endurance-evidence-'));
  try {
    const { report, keys, expectedAttestationKeySha256 } = await createSyntheticEvidence(root);
    const options = validationOptions(root, expectedAttestationKeySha256);
    await validatePersonaGoalEndurance(options);

    await t.test('zero eligible denominator cannot pass with a refreshed trusted signature', async () => {
      const changed = structuredClone(report);
      changed.metrics.eligibleRounds = 0;
      changed.metrics.autonomousEligibleRounds = 0;
      changed.metrics.unattendedRoundRate = null;
      await writeReport(root, changed, keys);
      await assert.rejects(
        validatePersonaGoalEndurance(options),
        /Eligible-round denominator/,
      );
    });

    await t.test('clock gaps cannot pass with a refreshed trusted signature', async () => {
      const changed = structuredClone(report);
      changed.intervals[4].startedAt = iso(33);
      await writeReport(root, changed, keys);
      await assert.rejects(
        validatePersonaGoalEndurance(options),
        /Clock gap or overlap/,
      );
    });

    await t.test('round attempt identity cannot diverge from its durable dispatch', async () => {
      const changed = structuredClone(report);
      changed.runtimeEvents[0].attemptKey = 'round-attempt-tampered';
      changed.goalRoundAdmissions[0].attemptKey = 'round-attempt-tampered';
      await writeSyntheticRuntimeProvenance(root, changed);
      await writeReport(root, changed, keys);
      await assert.rejects(
        validatePersonaGoalEndurance(options),
        /durable dispatch identity/,
      );
    });

    await t.test('manual retry round must resolve to its persisted control event', async () => {
      const changed = structuredClone(report);
      const retryRound = changed.runtimeEvents.find(event => event.cause === 'manual_retry');
      retryRound.controlId = 'goalcontrol-missing-unit';
      changed.goalRoundAdmissions.find(value => value.cause === 'manual_retry').controlId
        = retryRound.controlId;
      await writeSyntheticRuntimeProvenance(root, changed);
      await writeReport(root, changed, keys);
      await assert.rejects(
        validatePersonaGoalEndurance(options),
        /owner-control attribution/,
      );
    });

    await t.test('unrelated cancellation cannot be attributed to the stop control', async () => {
      const changed = structuredClone(report);
      const dispatch = changed.dispatches[4];
      dispatch.state = 'cancelled';
      dispatch.activityId = undefined;
      dispatch.cancellationRequestedAt = Date.parse(iso(60));
      dispatch.cancellationReason = 'The ongoing goal was stopped.';
      dispatch.cancellationControlId = 'goalcontrol-unrelated-unit';
      const admission = changed.goalRoundAdmissions[4];
      admission.dispatchState = 'cancelled';
      admission.activityId = undefined;
      admission.ownerCancelledBeforeDispatch = true;
      changed.metrics.eligibleRounds = 4;
      changed.metrics.autonomousEligibleRounds = 4;
      changed.metrics.unattendedRoundRate = 1;
      await writeSyntheticRuntimeProvenance(root, changed);
      await writeReport(root, changed, keys);
      await assert.rejects(
        validatePersonaGoalEndurance(options),
        /owner-control causality/,
      );
    });

    await t.test('duplicate trusted effects cannot pass with a refreshed trusted signature', async () => {
      await writeSyntheticRuntimeProvenance(root, report);
      await writeReport(root, report, keys);
      const statePath = path.join(root, 'trusted-verifier', 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      state.effects.push({ ...state.effects[0], id: 'duplicate-publication' });
      await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
      await writeEnduranceEvidenceAttestation({
        directory: root,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        runId: report.runIdentity.runId,
        commitSha: report.runIdentity.commitSha,
        sourceDiffSha256: report.runIdentity.sourceDiffSha256,
      });
      await assert.rejects(
        validatePersonaGoalEndurance(options),
        /Exactly one matching external effect/,
      );
    });

    await t.test('rewritten checksums cannot replace the runner-owned signature', async () => {
      await writeSyntheticRuntimeProvenance(root, report);
      await writeReport(root, report, keys);
      const changed = structuredClone(report);
      changed.metrics.eligibleRounds = 999;
      await writeFile(
        path.join(root, 'persona-goal-endurance.json'),
        JSON.stringify(changed, null, 2) + '\n',
      );
      await writeChecksums(root);
      await assert.rejects(
        validatePersonaGoalEndurance(options),
        /attestation signature or checksum binding/,
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
