import { promises as fs } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';

import type { FlowRunInput, FlowRunResult } from '@/backend/execution/flow/runFlow';
import {
  BEHAVIOR_OUTCOME_MIN_SAMPLES,
  PersonaFlowDispatcher,
  _getPersonaRuntimeEventLogStateForTests,
  _setPersonaRuntimeClockForTests,
  _setPersonaRuntimeEventLogConfigForTests,
  acknowledgePersonaActivityDelivery,
  activateBehaviorProposal,
  appendPersonaRuntimeEvent,
  approveBehaviorProposal,
  claimNextPersonaActivity,
  completePersonaActivity,
  createBehaviorProposal,
  getBehaviorProposal,
  getPersonaStorageStats,
  inspectAndReconcilePersonaRuntime,
  prunePersonaLeaseHistory,
  recordBehaviorOutcomeSample,
  recoverPersonaRuntime,
  routePersonaMailboxItem,
  searchPersonaMemory,
  sweepPersonaRuntimeEventSegments,
  type BehaviorProposalCompileResult,
  type PersonaActivityClaim,
  type PersonaFlowDispatchRecord,
} from '@/backend/services/enduringAgents';
import {
  getBehaviorBinding,
  getBehaviorOutcomeMetric,
  getBehaviorRevision,
  getPersonaActivity,
  getPersonaLeaseRecord,
  listPersonaActivities,
  listPersonaLeaseRecords,
  listPersonaMailboxItems,
  saveMemoryItem,
  savePersonaActivity,
} from '@/backend/services/enduringAgents/store';
import { behaviorOutcomeMetricId } from '@/backend/services/enduringAgents/behaviorOutcome';
import {
  compactPersonaActivities,
  compactPersonaFlowDispatches,
  compactPersonaMailboxItems,
} from '@/backend/services/enduringAgents/compactRuntime';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { FEATURES } from '@/config/features';
import {
  ENDURING_AGENT_SCHEMA_VERSION,
  MemoryItemSchema,
  PersonaActivitySchema,
  PERSONA_ACTIVITY_OUTCOME_SCHEMA_VERSION,
  PERSONA_ACTIVITY_SCHEMA_VERSION,
  type BehaviorRevision,
  type MemoryItem,
  type PersonaActivity,
  type PersonaLease,
} from '@/shared/types/enduringAgent';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { runWithWorkspace } from '@/utils/workspace';

import {
  createPersonaProcessEnvironment,
  removePersonaProcessEnvironment,
  restartPersonaProcess,
  startPersonaProcess,
  type PersonaProcessClient,
} from '../personaProcessBoundaryHarness';
import { createPersonaFromRole } from '../fixtures/personaFactory';
import { defaultFaultSchedule, type SoakFaultKind } from './faultInjector';
import { scoreRecallPrecision } from './groundTruth';
import {
  percentile,
  renderSoakReport,
  type DailySoakMetric,
  type SoakCriterionResult,
} from './metrics';
import { createSeededStubModel } from './stubModel';
import { VirtualPersonaRuntimeClock } from './virtualClock';
import { generatePersonaSoakWorkload, type SoakActivity } from './workloadGenerator';

export interface PersonaSoakOptions {
  days: number;
  activitiesPerDay: number;
  seed: number;
  outputDirectory?: string;
  gatingMode?: 'enforce' | 'warn' | 'report';
  withLearning?: boolean;
}

export interface PersonaSoakSummary {
  seed: number;
  days: number;
  activities: number;
  ingressLabels: string[];
  splitBrainCount: number;
  strandedLeaseCount: number;
  stuckPersonaCount: number;
  learning: 'passed' | 'failed' | 'skipped';
  runtimeEvidence: {
    workspaceId: string;
    personaId: string;
    persistedActivities: number;
    persistedMailboxItems: number;
    persistedLeaseAcquisitions: number;
    persistedDispatches: number;
    modelCalls: number;
  };
  criteria: SoakCriterionResult[];
  metrics: DailySoakMetric[];
}

interface MutableFeatureSnapshot {
  runtimeRetention: boolean;
  leasePruning: boolean;
  maintenanceAdmission: boolean;
  maintenanceDiagnosis: boolean;
  outcomeMetrics: boolean;
  outcomeAutoRollback: boolean;
}

interface ProcessPersona {
  persona: { id: string };
}

interface ProcessClaim {
  activity: { id: string };
  lease: { fencingToken: number };
  fence: {
    workspaceId: string;
    personaId: string;
    activityId: string;
    leaseId: string;
    holderId: string;
    fencingToken: number;
  };
  recovered: boolean;
}

const DAY_MS = 86_400_000;
const RECALL_SAMPLES_PER_DAY = 5;
const APPEND_SAMPLES_PER_DAY = 5;
const FULL_GATE_DAYS = 28;
const FULL_GATE_ACTIVITIES_PER_DAY = 20;
const LEASE_HISTORY_SOAK_CAP = 50;
const MAX_RESIDENT_GROWTH_BYTES = 128 * 1024 * 1024;
let workspaceSequence = 0;

function debug(message: string): void {
  if (
    process.env.PERSONA_SOAK_DEBUG === '1'
    || process.env.PERSONA_SOAK_DEBUG === 'verbose'
  ) {
    process.stderr.write(`[persona-soak] ${message}\n`);
  }
}

function debugActivity(message: string): void {
  if (process.env.PERSONA_SOAK_DEBUG === 'verbose') {
    process.stderr.write(`[persona-soak] ${message}\n`);
  }
}

function featureSnapshot(): MutableFeatureSnapshot {
  return {
    runtimeRetention: FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION,
    leasePruning: FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING,
    maintenanceAdmission: FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION,
    maintenanceDiagnosis: FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS,
    outcomeMetrics: FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS,
    outcomeAutoRollback: FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK,
  };
}

function restoreFeatures(snapshot: MutableFeatureSnapshot): void {
  FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION = snapshot.runtimeRetention;
  FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = snapshot.leasePruning;
  FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = snapshot.maintenanceAdmission;
  FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = snapshot.maintenanceDiagnosis;
  FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS = snapshot.outcomeMetrics;
  FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = snapshot.outcomeAutoRollback;
}

function fenceForClaim(claim: PersonaActivityClaim) {
  return {
    workspaceId: claim.lease.workspaceId,
    personaId: claim.activity.personaId,
    activityId: claim.activity.id,
    leaseId: claim.lease.id,
    holderId: claim.lease.holderId,
    fencingToken: claim.lease.fencingToken,
  };
}

function flowResult(input: FlowRunInput, outputText: string): FlowRunResult {
  return {
    status: 'completed',
    conversationId: input.conversationId!,
    runId: input.runId!,
    outputText,
    messages: [],
    sharedState: {} as FlowRunResult['sharedState'],
  };
}

function processNode(flow: Flow): FlowNode {
  const node = flow.nodes.find((candidate) => candidate.type === 'process');
  if (!node) throw new Error('The soak learning fixture has no process node.');
  return node;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function workloadSourceId(activity: SoakActivity, suffix = ''): string {
  return `soak-workload-${activity.id}${suffix}`;
}

function criterion(
  key: string,
  passed: boolean,
  summary: string,
  evidence: SoakCriterionResult['evidence'],
): SoakCriterionResult {
  return { key, status: passed ? 'passed' : 'failed', summary, evidence };
}

function notEvaluated(
  key: string,
  summary: string,
  evidence: SoakCriterionResult['evidence'] = {},
): SoakCriterionResult {
  return { key, status: 'not_evaluated', summary, evidence };
}

async function routeSteeringActivity(
  personaId: string,
  activity: SoakActivity,
): Promise<void> {
  const relationKey = `soak-relation-${activity.id}`;
  const host = await routePersonaMailboxItem({
    personaId,
    idempotencyKey: `${activity.id}-host`,
    kind: 'interactive_chat',
    source: { kind: 'chat', sourceId: workloadSourceId(activity, '-host') },
    relationKey,
    summary: `Host Activity for ${activity.ingress.label}`,
  });
  if (host.decision !== 'queued') {
    throw new Error(`Steering host ${activity.id} was not queued.`);
  }
  const claim = await claimNextPersonaActivity({ personaId, ttlMs: 30_000 });
  if (!claim) throw new Error(`Steering host ${activity.id} was not claimed.`);
  const related = await routePersonaMailboxItem({
    personaId,
    idempotencyKey: `${activity.id}-related`,
    kind: 'interactive_chat',
    source: { kind: 'chat', sourceId: workloadSourceId(activity, '-related') },
    relationKey,
    relatedAction: 'steer',
    summary: `Related input for ${activity.ingress.label}`,
  });
  if (related.decision !== 'steered' || related.targetActivityId !== claim.activity.id) {
    throw new Error(`Related input ${activity.id} did not steer into its live Activity.`);
  }
  await acknowledgePersonaActivityDelivery({
    ...fenceForClaim(claim),
    mailboxItemId: related.item.id,
  });
  await completePersonaActivity({ ...fenceForClaim(claim), status: 'completed' });
}

async function dispatchWorkloadActivity(
  dispatcher: PersonaFlowDispatcher,
  personaId: string,
  activity: SoakActivity,
): Promise<PersonaFlowDispatchRecord> {
  const submission = await dispatcher.submit({
    personaId,
    idempotencyKey: activity.id,
    kind: activity.ingress.mailboxKind,
    source: {
      kind: activity.ingress.sourceKind,
      sourceId: workloadSourceId(activity),
    },
    relationKey: `soak-relation-${activity.id}`,
    summary: `Runtime-backed soak input ${activity.id} (${activity.variant})`,
    flowInput: {
      source: 'api',
      prompt: `Complete deterministic soak input ${activity.id}.`,
      mode: 'conversation',
    },
  }, { waitForCompletion: true, timeoutMs: 30_000 });
  if (submission.dispatch.state !== 'completed' || !submission.dispatch.activityId) {
    throw new Error(`Dispatch ${submission.dispatch.id} did not complete a persisted Activity.`);
  }
  await dispatcher.pump(personaId);
  return submission.dispatch;
}

async function compactRuntime(personaId: string, now: number): Promise<void> {
  await withPersonaRuntimeLock(personaId, async () => {
    await compactPersonaMailboxItems(personaId, now);
    await compactPersonaActivities(personaId, now);
    await compactPersonaFlowDispatches(personaId, now);
  });
  FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = true;
  await prunePersonaLeaseHistory(personaId, {
    retainedCount: LEASE_HISTORY_SOAK_CAP,
    maxDeletesPerSweep: 10_000,
  });
  FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = false;
  await sweepPersonaRuntimeEventSegments();
}

async function exerciseLeaseExpiry(
  personaId: string,
  clock: VirtualPersonaRuntimeClock,
  token: string,
): Promise<void> {
  await routePersonaMailboxItem({
    personaId,
    idempotencyKey: `fault-lease-expiry-${token}`,
    kind: 'assignment',
    source: { kind: 'assignment', sourceId: `soak-fault-lease-expiry-${token}` },
    summary: 'Exercise expired-lease recovery.',
  });
  const first = await claimNextPersonaActivity({ personaId, ttlMs: 1_000 });
  if (!first) throw new Error('Lease-expiry fault could not claim its Activity.');
  await clock.advanceBy(1_001);
  const recovered = await claimNextPersonaActivity({ personaId, ttlMs: 1_000 });
  if (!recovered) {
    const [activity, expiredLease] = await Promise.all([
      getPersonaActivity(personaId, first.activity.id),
      getPersonaLeaseRecord(first.lease.id),
    ]);
    if (
      (activity?.status !== 'error' && activity?.status !== 'cancelled')
      || expiredLease?.status === 'active'
    ) {
      throw new Error('Lease-expiry reconciliation neither recovered nor safely terminalized the Activity.');
    }
    return;
  }
  if (
    !recovered.recovered
    || recovered.activity.id !== first.activity.id
    || recovered.lease.fencingToken <= first.lease.fencingToken
  ) {
    throw new Error(`Lease-expiry fault did not recover the Activity with a higher fence: ${JSON.stringify({
      first: {
        activityId: first.activity.id,
        token: first.lease.fencingToken,
        expiresAt: first.lease.expiresAt,
      },
      recovered: recovered ? {
        activityId: recovered.activity.id,
        token: recovered.lease.fencingToken,
        recovered: recovered.recovered,
      } : null,
      now: clock.now(),
    })}`);
  }
  await completePersonaActivity({ ...fenceForClaim(recovered), status: 'completed' });
}

async function exerciseConcurrentClaimant(personaId: string, token: string): Promise<void> {
  await routePersonaMailboxItem({
    personaId,
    idempotencyKey: `fault-concurrent-${token}`,
    kind: 'assignment',
    source: { kind: 'assignment', sourceId: `soak-fault-concurrent-${token}` },
    summary: 'Exercise concurrent claim exclusion.',
  });
  const attempts = await Promise.allSettled([
    claimNextPersonaActivity({ personaId, ttlMs: 30_000 }),
    claimNextPersonaActivity({ personaId, ttlMs: 30_000 }),
  ]);
  const claims = attempts
    .filter((attempt): attempt is PromiseFulfilledResult<PersonaActivityClaim | null> => (
      attempt.status === 'fulfilled'
    ))
    .map((attempt) => attempt.value)
    .filter((claim): claim is PersonaActivityClaim => claim !== null);
  if (claims.length !== 1) {
    throw new Error(`Concurrent-claimant fault produced ${claims.length} successful claims.`);
  }
  await completePersonaActivity({ ...fenceForClaim(claims[0]), status: 'completed' });
}

async function exerciseGracefulRestart(
  dispatcher: PersonaFlowDispatcher,
  makeDispatcher: () => PersonaFlowDispatcher,
  personaId: string,
  token: string,
): Promise<PersonaFlowDispatcher> {
  const submission = await dispatcher.submit({
    personaId,
    idempotencyKey: `fault-graceful-restart-${token}`,
    kind: 'assignment',
    source: { kind: 'assignment', sourceId: `soak-fault-graceful-${token}` },
    summary: 'Persist work before replacing the dispatcher instance.',
    flowInput: {
      source: 'api',
      prompt: 'Complete after a graceful dispatcher restart.',
      mode: 'conversation',
    },
  }, { startPump: false });
  const restarted = makeDispatcher();
  await restarted.reconcileAndDrain();
  const record = await restarted.get(submission.dispatch.id);
  if (record?.state !== 'completed') {
    throw new Error('Graceful-restart fault did not drain the durable dispatch.');
  }
  return restarted;
}

async function exerciseAdministrativeRecovery(personaId: string): Promise<void> {
  const recovered = await recoverPersonaRuntime({ personaId, confirmation: 'RECOVER' });
  if (recovered.lifecycleState !== 'idle' || recovered.closedActivityIds.length > 0) {
    throw new Error('Administrative recovery did not leave an idle, coherent runtime.');
  }
}

async function exerciseHardCrashProcessBoundary(seed: number): Promise<void> {
  const environment = await createPersonaProcessEnvironment(`soak-hard-crash-${seed}`);
  const clients: PersonaProcessClient[] = [];
  try {
    const first = await startPersonaProcess(environment);
    clients.push(first);
    const created = await first.request<ProcessPersona>({
      type: 'createPersona',
      name: 'Soak hard-crash Persona',
      idempotencyKey: `soak-hard-crash-persona-${seed}`,
      coreFlowRef: `soak-hard-crash-flow-${seed}`,
    });
    await first.request({
      type: 'enqueue',
      input: {
        personaId: created.persona.id,
        idempotencyKey: `soak-hard-crash-work-${seed}`,
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: `soak-hard-crash-source-${seed}` },
        summary: 'Recover one active Activity after SIGKILL.',
      },
    });
    const before = await first.request<ProcessClaim>({
      type: 'claim', personaId: created.persona.id, ttlMs: 1_000,
    });
    await first.kill();
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const restarted = await restartPersonaProcess(environment);
    clients.push(restarted);
    const after = await restarted.request<ProcessClaim>({
      type: 'claim', personaId: created.persona.id, ttlMs: 1_000,
    });
    if (
      !after.recovered
      || after.activity.id !== before.activity.id
      || after.lease.fencingToken <= before.lease.fencingToken
    ) {
      throw new Error('Hard-crash process recovery did not preserve Activity identity and advance the fence.');
    }
    await restarted.request({ type: 'complete', fence: after.fence });
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await removePersonaProcessEnvironment(environment);
  }
}

function terminalLearningActivity(input: {
  id: string;
  personaId: string;
  behaviorId: string;
  revisionId: string;
  succeeded: boolean;
  at: number;
}): PersonaActivity {
  return PersonaActivitySchema.parse({
    schemaVersion: PERSONA_ACTIVITY_SCHEMA_VERSION,
    id: input.id,
    personaId: input.personaId,
    kind: 'assignment',
    status: 'completed',
    source: { kind: 'assignment', sourceId: input.id },
    behaviorId: input.behaviorId,
    behaviorRevisionId: input.revisionId,
    outcome: {
      schemaVersion: PERSONA_ACTIVITY_OUTCOME_SCHEMA_VERSION,
      resolution: input.succeeded ? 'succeeded' : 'failed',
      ...(input.succeeded ? {} : { blockerKind: 'unknown' }),
      decisionSource: 'engine',
      evidenceRefs: [],
      decidedAt: input.at,
    },
    createdAt: input.at,
    updatedAt: input.at,
    startedAt: input.at,
    completedAt: input.at,
  }) as PersonaActivity;
}

async function exerciseLearningRollback(seed: number): Promise<boolean> {
  FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS = true;
  FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = true;
  FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = true;
  FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;

  const setup = await createPersonaFromRole({
    name: 'Soak learning Persona',
    autonomyLevel: 'propose_overrides',
    idempotencyKey: `soak-learning-persona-${seed}`,
  });
  const binding = setup.behaviorBindings.find((candidate) => candidate.slotKey === 'primary');
  if (!binding) throw new Error('Learning soak Persona has no Primary Behavior binding.');
  const baseRevision = await getBehaviorRevision(binding.activeRevisionId);
  if (!baseRevision) throw new Error('Learning soak Persona has no active base revision.');
  const baselineAt = Date.now() - 1_000;
  for (let index = 0; index < BEHAVIOR_OUTCOME_MIN_SAMPLES; index += 1) {
    await savePersonaActivity(terminalLearningActivity({
      id: `soak_learning_baseline_${seed}_${index}`,
      personaId: setup.persona.id,
      behaviorId: binding.id,
      revisionId: baseRevision.id,
      succeeded: true,
      at: baselineAt,
    }));
  }

  const compiler = async (): Promise<BehaviorProposalCompileResult> => {
    const flow = clone(baseRevision.flowSnapshot);
    const node = processNode(flow);
    node.data.properties = {
      ...node.data.properties,
      promptTemplate: 'Use the deliberately regressed soak instruction and verify outcomes.',
    };
    return { success: true, flow, errorCount: 0, warningCount: 0, issues: [] };
  };
  const proposal = await createBehaviorProposal({
    personaId: setup.persona.id,
    behaviorId: binding.id,
    baseBehaviorRevisionId: baseRevision.id,
    rationale: 'The soak gate needs a real activated revision to test automatic regression rollback.',
    evidenceRefs: [{ kind: 'activity', id: `soak_learning_baseline_${seed}_0`, observedAt: baselineAt }],
    candidateSpec: { soak: 'deliberate-regression' },
    evals: [{
      id: 'soak-candidate-compiles',
      run: ({ candidateFlow }) => ({ passed: processNode(candidateFlow).data.properties?.promptTemplate
        === 'Use the deliberately regressed soak instruction and verify outcomes.' }),
    }],
    actor: 'persona-soak',
  }, { compiler });
  await approveBehaviorProposal(proposal.id, {
    actor: 'persona-soak-reviewer',
    reason: 'Deliberately activate a deterministic regression for rollback verification.',
  });
  const activated = await activateBehaviorProposal(proposal.id);
  if (!activated.activatedRevisionId) throw new Error('Learning soak proposal was not activated.');

  for (let index = 0; index < BEHAVIOR_OUTCOME_MIN_SAMPLES; index += 1) {
    const failed = terminalLearningActivity({
      id: `soak_learning_regression_${seed}_${index}`,
      personaId: setup.persona.id,
      behaviorId: binding.id,
      revisionId: activated.activatedRevisionId,
      succeeded: false,
      at: Date.now(),
    });
    await savePersonaActivity(failed);
    await recordBehaviorOutcomeSample(failed);
  }
  const [metric, currentBinding, currentProposal] = await Promise.all([
    getBehaviorOutcomeMetric(behaviorOutcomeMetricId(proposal.id)),
    getBehaviorBinding(binding.id),
    getBehaviorProposal(proposal.id),
  ]);
  return metric?.verdict === 'rolled_back'
    && currentBinding?.activeRevisionId === baseRevision.id
    && currentProposal?.status === 'rolled_back';
}

function overlappingLeasePairs(leases: PersonaLease[]): string[] {
  const ordered = [...leases].sort((left, right) => (
    left.acquiredAt - right.acquiredAt || left.fencingToken - right.fencingToken
  ));
  const overlaps: string[] = [];
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex];
    const leftEnd = Math.min(left.releasedAt ?? left.expiresAt, left.expiresAt);
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex];
      if (right.acquiredAt >= leftEnd) break;
      const rightEnd = Math.min(right.releasedAt ?? right.expiresAt, right.expiresAt);
      if (left.acquiredAt < rightEnd) {
        overlaps.push([left.id, right.id].sort().join(':'));
      }
    }
  }
  return overlaps;
}

async function createRecallFixtures(personaId: string, now: number): Promise<MemoryItem> {
  const item = MemoryItemSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id: 'soak_memory_release_branch',
    personaId,
    kind: 'semantic',
    scope: 'persona',
    status: 'active',
    content: 'The release branch sentinel is orchid-489.',
    confidence: 1,
    importance: 1,
    sourceRefs: [{ kind: 'tool_result', id: 'soak-ground-truth' }],
    trust: 'verified_tool',
    createdAt: now,
    updatedAt: now,
  }) as MemoryItem;
  return saveMemoryItem(item);
}

async function createDailyNoiseMemory(personaId: string, day: number, now: number): Promise<void> {
  await saveMemoryItem(MemoryItemSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id: `soak_memory_noise_${day}`,
    personaId,
    kind: 'semantic',
    scope: 'persona',
    status: 'active',
    content: `Unrelated deterministic noise fact for simulated day ${day}.`,
    confidence: 0.5,
    importance: 0.2,
    sourceRefs: [{ kind: 'tool_result', id: `soak-noise-${day}` }],
    trust: 'verified_tool',
    createdAt: now,
    updatedAt: now,
  }) as MemoryItem);
}

export async function runPersonaSoak(options: PersonaSoakOptions): Promise<PersonaSoakSummary> {
  const fullGate = options.days >= FULL_GATE_DAYS
    && options.activitiesPerDay >= FULL_GATE_ACTIVITIES_PER_DAY;
  const startedAt = Date.now() + 1_000;
  const clock = new VirtualPersonaRuntimeClock(startedAt, 100_000);
  const workload = generatePersonaSoakWorkload({ ...options, startAt: startedAt });
  const faults = defaultFaultSchedule(options.days);
  const metrics: DailySoakMetric[] = [];
  const features = featureSnapshot();
  const previousClock = _setPersonaRuntimeClockForTests(clock);
  const previousEventConfig = _setPersonaRuntimeEventLogConfigForTests({
    maxSegmentBytes: 1_048_576,
    maxSegmentEvents: 100,
    retentionDays: 7,
    maxClosedSegments: 2,
  });
  workspaceSequence += 1;
  const workspaceId = `persona-soak-${process.pid}-${options.seed}-${workspaceSequence}`;
  let summary: PersonaSoakSummary | undefined;

  try {
    summary = await runWithWorkspace(workspaceId, async () => {
      FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION = false;
      FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = false;
      FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = false;
      FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
      FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS = false;
      FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = false;

      const bundle = await createPersonaFromRole({
        name: 'Runtime-backed soak Persona',
        autonomyLevel: 'propose_overrides',
        interruptionPolicy: 'related_only',
        idempotencyKey: `persona-soak-${options.seed}`,
      });
      const personaId = bundle.persona.id;
      debug(`created Persona ${personaId}`);
      const groundTruth = await createRecallFixtures(personaId, clock.now());
      const stubModel = createSeededStubModel(options.seed, [{
        id: groundTruth.id,
        subject: 'release branch sentinel',
        value: 'orchid-489',
      }]);
      let modelCalls = 0;
      const runFlowStub = async (input: FlowRunInput): Promise<FlowRunResult> => {
        debugActivity(`runFlow entered for ${input.personaAttribution?.activityId ?? 'unknown Activity'}`);
        modelCalls += 1;
        const completion = await stubModel.createCompletion({} as never);
        const output = completion.completion.choices[0]?.message.content;
        const result = flowResult(input, typeof output === 'string' ? output : '');
        debugActivity(`runFlow completed for ${input.personaAttribution?.activityId ?? 'unknown Activity'}`);
        return result;
      };
      const makeDispatcher = () => new PersonaFlowDispatcher({
        workspaceId,
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 5_000,
        dependencies: { runFlow: runFlowStub },
      });
      let dispatcher = makeDispatcher();
      let hardCrashExecuted = false;
      const persistedLeaseOverlapPairs = new Set<string>();

      for (let day = 1; day <= options.days; day += 1) {
        debug(`day ${day} started`);
        const dailyWorkload = workload.filter((activity) => activity.day === day);
        const completedBefore = (await listPersonaActivities(personaId)).filter((activity) => (
          activity.status === 'completed'
          && activity.source.sourceId?.startsWith('soak-workload-')
        )).length;
        for (const activity of dailyWorkload) {
          debugActivity(`day ${day} dispatching ${activity.id} via ${activity.ingress.admission}`);
          await clock.advanceTo(activity.scheduledAt);
          if (activity.ingress.admission === 'steering') {
            await routeSteeringActivity(personaId, activity);
          } else {
            await dispatchWorkloadActivity(dispatcher, personaId, activity);
          }
        }

        const scheduledFaults = faults.filter((fault) => fault.day === day);
        const executedFaults: string[] = [];
        for (const fault of scheduledFaults) {
          debug(`day ${day} executing fault ${fault.kind}`);
          const token = `${day}-${fault.kind}`;
          switch (fault.kind) {
            case 'lease-expiry':
              await exerciseLeaseExpiry(personaId, clock, token);
              executedFaults.push(fault.kind);
              break;
            case 'concurrent-claimant':
              await exerciseConcurrentClaimant(personaId, token);
              executedFaults.push(fault.kind);
              break;
            case 'graceful-restart':
              dispatcher = await exerciseGracefulRestart(
                dispatcher, makeDispatcher, personaId, token,
              );
              executedFaults.push(fault.kind);
              break;
            case 'administrative-recovery':
              await exerciseAdministrativeRecovery(personaId);
              executedFaults.push(fault.kind);
              break;
            case 'hard-crash':
              if (fullGate) {
                await exerciseHardCrashProcessBoundary(options.seed);
                hardCrashExecuted = true;
                executedFaults.push(fault.kind);
              }
              break;
            default: {
              const exhaustive: never = fault.kind;
              throw new Error(`Unsupported soak fault: ${exhaustive}`);
            }
          }
        }

        await clock.advanceTo(startedAt + day * DAY_MS);
        await createDailyNoiseMemory(personaId, day, clock.now());
        for (const pair of overlappingLeasePairs(await listPersonaLeaseRecords(personaId))) {
          persistedLeaseOverlapPairs.add(pair);
        }
        await compactRuntime(personaId, clock.now());

        const recallSamples: number[] = [];
        const recallObservations = [];
        for (let sample = 0; sample < RECALL_SAMPLES_PER_DAY; sample += 1) {
          const recallStarted = performance.now();
          const recalled = await searchPersonaMemory(personaId, {
            query: 'release branch sentinel orchid-489',
            mode: 'lexical',
            asOf: clock.now(),
            limit: 1,
          });
          recallSamples.push(performance.now() - recallStarted);
          recallObservations.push({
            expectedId: groundTruth.id,
            recalledIds: recalled.map((result) => result.item.id),
          });
        }

        const appendSamples: number[] = [];
        for (let sample = 0; sample < APPEND_SAMPLES_PER_DAY; sample += 1) {
          const appendStarted = performance.now();
          await appendPersonaRuntimeEvent(personaId, {
            eventId: `soak.append.${day}.${sample}`,
            type: 'recovery:completed',
            changed: false,
            remainingStuckCount: 0,
          });
          appendSamples.push(performance.now() - appendStarted);
        }

        const [storage, activities] = await Promise.all([
          getPersonaStorageStats(personaId),
          listPersonaActivities(personaId),
        ]);
        const completedAfter = activities.filter((activity) => (
          activity.status === 'completed'
          && activity.source.sourceId?.startsWith('soak-workload-')
        )).length;
        const eventState = _getPersonaRuntimeEventLogStateForTests(personaId);
        metrics.push({
          day,
          activitiesAttempted: dailyWorkload.length,
          activitiesSucceeded: completedAfter - completedBefore,
          recallPrecision: scoreRecallPrecision(recallObservations),
          recallP95Ms: percentile(recallSamples, 0.95),
          residentMemoryBytes: process.memoryUsage().rss,
          eventAppendP95Ms: percentile(appendSamples, 0.95),
          eventLogSegments: eventState?.segmentCount ?? 0,
          collectionCounts: Object.fromEntries(
            Object.entries(storage.kinds).map(([key, value]) => [key, value.total]),
          ),
          collectionUncompactedCounts: Object.fromEntries(
            Object.entries(storage.kinds).map(([key, value]) => [key, value.uncompacted]),
          ),
          faultsScheduled: scheduledFaults.map((fault) => fault.kind),
          faultsExecuted: executedFaults,
        });
        debug(`day ${day} completed`);
      }

      _setPersonaRuntimeClockForTests(previousClock);
      debug(`starting learning rollback=${Boolean(options.withLearning)}`);
      const learning = options.withLearning
        ? await exerciseLearningRollback(options.seed)
        : false;
      debug(`learning rollback completed=${learning}`);
      _setPersonaRuntimeClockForTests(clock);

      const [activities, mailboxItems, leases, dispatches, runtime] = await Promise.all([
        listPersonaActivities(personaId),
        listPersonaMailboxItems(personaId),
        listPersonaLeaseRecords(personaId),
        dispatcher.list(personaId),
        inspectAndReconcilePersonaRuntime(personaId),
      ]);
      const workloadCompleted = activities.filter((activity) => (
        activity.status === 'completed'
        && activity.source.sourceId?.startsWith('soak-workload-')
      )).length;
      for (const pair of overlappingLeasePairs(leases)) persistedLeaseOverlapPairs.add(pair);
      const splitBrainCount = persistedLeaseOverlapPairs.size;
      const strandedLeaseCount = leases.filter((lease) => lease.status === 'active').length;
      const stuckPersonaCount = runtime?.projection.stuck ? 1 : 0;
      const firstMetric = metrics[0];
      const lastMetric = metrics.at(-1)!;
      const expectedActivities = options.days * options.activitiesPerDay;
      const firstAppend = firstMetric.eventAppendP95Ms;
      const allowedAppend = firstAppend * 3 + 10;
      const residentGrowth = lastMetric.residentMemoryBytes - firstMetric.residentMemoryBytes;
      const maxUncompacted = lastMetric.collectionUncompactedCounts;
      const criteria: SoakCriterionResult[] = [
        criterion(
          'unattended-runtime-throughput',
          workloadCompleted === expectedActivities,
          `${workloadCompleted}/${expectedActivities} generated inputs became terminal persisted Activities.`,
          { workloadCompleted, expectedActivities },
        ),
        criterion(
          'recall-precision-stability',
          lastMetric.recallPrecision >= firstMetric.recallPrecision - 0.05,
          `Day 1=${firstMetric.recallPrecision.toFixed(4)}, day ${options.days}=${lastMetric.recallPrecision.toFixed(4)}.`,
          { day1: firstMetric.recallPrecision, final: lastMetric.recallPrecision },
        ),
        criterion(
          'runtime-scale-recall-latency',
          lastMetric.recallP95Ms < 150,
          `Measured production search p95=${lastMetric.recallP95Ms.toFixed(2)} ms at soak scale; the 50k gate runs separately.`,
          { p95Ms: lastMetric.recallP95Ms },
        ),
        criterion(
          'bounded-detailed-runtime-state',
          (maxUncompacted.mailboxItems ?? Infinity) <= 500
            && (maxUncompacted.activities ?? Infinity) <= 200
            && (maxUncompacted.flowDispatches ?? Infinity) <= 200
            && (lastMetric.collectionCounts.leaseHistory ?? Infinity) <= LEASE_HISTORY_SOAK_CAP + 1
            && lastMetric.eventLogSegments <= 3,
          'Detailed payloads, lease acquisitions, and event segments stayed within checked-in caps.',
          {
            mailboxUncompacted: maxUncompacted.mailboxItems ?? -1,
            activityUncompacted: maxUncompacted.activities ?? -1,
            dispatchUncompacted: maxUncompacted.flowDispatches ?? -1,
            leaseRecords: lastMetric.collectionCounts.leaseHistory ?? -1,
            eventSegments: lastMetric.eventLogSegments,
          },
        ),
        criterion(
          'flat-event-append-cost',
          lastMetric.eventAppendP95Ms <= allowedAppend,
          `Day 1=${firstAppend.toFixed(2)} ms, final=${lastMetric.eventAppendP95Ms.toFixed(2)} ms.`,
          { day1P95Ms: firstAppend, finalP95Ms: lastMetric.eventAppendP95Ms, allowedP95Ms: allowedAppend },
        ),
        criterion(
          'zero-split-brain',
          splitBrainCount === 0,
          `${splitBrainCount} overlapping lease acquisitions were found in persisted history.`,
          { splitBrainCount },
        ),
        criterion(
          'zero-stranded-or-stuck',
          strandedLeaseCount === 0 && stuckPersonaCount === 0,
          `Active leases=${strandedLeaseCount}; stuck Personas=${stuckPersonaCount}.`,
          { strandedLeaseCount, stuckPersonaCount },
        ),
        criterion(
          'resident-memory-bound',
          residentGrowth <= MAX_RESIDENT_GROWTH_BYTES,
          `Resident growth=${residentGrowth} bytes (allowance ${MAX_RESIDENT_GROWTH_BYTES}).`,
          { residentGrowthBytes: residentGrowth, allowedGrowthBytes: MAX_RESIDENT_GROWTH_BYTES },
        ),
        options.withLearning
          ? criterion(
              'learning-auto-rollback',
              learning,
              learning
                ? 'A persisted regression rolled the active Behavior binding back to its base revision.'
                : 'The regression was not rolled back.',
              { learning },
            )
          : notEvaluated('learning-auto-rollback', 'Run with --with-learning to evaluate rollback.'),
        fullGate
          ? criterion(
              'os-process-hard-crash-recovery',
              hardCrashExecuted,
              hardCrashExecuted
                ? 'A killed child process recovered the same Activity with a higher fence.'
                : 'The process-boundary fault was scheduled but did not execute.',
              { hardCrashExecuted },
            )
          : notEvaluated(
              'os-process-hard-crash-recovery',
              'Only the full 28-day/20-activity gate runs the OS-process crash scenario.',
            ),
      ];

      return {
        seed: options.seed,
        days: options.days,
        activities: workloadCompleted,
        ingressLabels: [...new Set(workload.map((activity) => activity.ingress.label))].sort(),
        splitBrainCount,
        strandedLeaseCount,
        stuckPersonaCount,
        learning: options.withLearning ? learning ? 'passed' : 'failed' : 'skipped',
        runtimeEvidence: {
          workspaceId,
          personaId,
          persistedActivities: activities.length,
          persistedMailboxItems: mailboxItems.length,
          persistedLeaseAcquisitions: leases.length,
          persistedDispatches: dispatches.length,
          modelCalls,
        },
        criteria,
        metrics,
      } satisfies PersonaSoakSummary;
    });
  } finally {
    _setPersonaRuntimeClockForTests(previousClock);
    _setPersonaRuntimeEventLogConfigForTests(previousEventConfig);
    restoreFeatures(features);
  }

  if (options.outputDirectory) {
    await fs.mkdir(options.outputDirectory, { recursive: true });
    await fs.writeFile(
      path.join(options.outputDirectory, 'persona-soak.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(options.outputDirectory, 'persona-soak.jsonl'),
      `${summary.metrics.map((metric) => JSON.stringify(metric)).join('\n')}\n`,
    );
    await fs.writeFile(
      path.join(options.outputDirectory, 'persona-soak.md'),
      renderSoakReport(summary.metrics, summary.criteria),
    );
  }

  const failed = summary.criteria.filter((item) => item.status === 'failed');
  const unevaluated = summary.criteria.filter((item) => item.status === 'not_evaluated');
  if (options.gatingMode === 'enforce') {
    if (failed.length > 0) {
      throw new Error(`Persona soak acceptance failed: ${failed.map((item) => item.key).join(', ')}.`);
    }
    if (fullGate && unevaluated.length > 0) {
      throw new Error(`Persona soak left criteria unevaluated: ${unevaluated.map((item) => item.key).join(', ')}.`);
    }
  }
  return summary;
}
