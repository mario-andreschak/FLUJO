import { promises as fs } from 'fs';
import { cpus, release } from 'os';
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
  readPersonaRuntimeEvents,
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
import { resolvePersonaCoreRevision } from '@/backend/services/enduringAgents/personaCoreResolver';
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
import {
  PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION,
  createSoakCriterion,
  soakEnforcementFailures,
  stableJsonStringify,
  type JsonObject,
  type LearningRollbackEvidence,
  type SoakCriterionId,
  type SoakCriterionResult,
  type SoakFaultEvidence,
  type SoakRunIdentity,
  type SoakRunMode,
  type WorkloadReconciliationEvidence,
} from './evidence';
import { defaultFaultSchedule, type SoakFaultKind } from './faultInjector';
import { scoreRecallPrecision } from './groundTruth';
import {
  percentile,
  renderSoakReport,
  type DailySoakMetric,
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
  commitSha?: string;
  runId?: string;
  runMode?: SoakRunMode;
}

export interface PersonaSoakSummary {
  schemaVersion: typeof PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION;
  runIdentity: SoakRunIdentity;
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
    behaviorBindingId: string;
    behaviorRevisionId: string;
    persistedActivities: number;
    persistedMailboxItems: number;
    persistedLeaseAcquisitions: number;
    persistedDispatches: number;
    modelCalls: number;
  };
  workloadReconciliation: WorkloadReconciliationEvidence;
  faultEvidence: SoakFaultEvidence[];
  learningEvidence: LearningRollbackEvidence;
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
  mailboxItem: { id: string };
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

interface ProcessRuntimeSnapshot {
  activities: Array<{ id: string; status: string; error?: string }>;
  mailboxItems: Array<{ id: string; status: string; claimedActivityId?: string }>;
  lease: { activityId: string; status: string; fencingToken: number } | null;
}

const DAY_MS = 86_400_000;
const RECALL_SAMPLES_PER_DAY = 5;
const APPEND_SAMPLES_PER_DAY = 5;
const FULL_GATE_DAYS = 28;
const FULL_GATE_ACTIVITIES_PER_DAY = 20;
const LEASE_HISTORY_SOAK_CAP = 50;
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

function criterion(input: {
  id: SoakCriterionId;
  mode: SoakRunMode;
  passed: boolean;
  summary: string;
  observed: JsonObject;
  threshold: string;
  thresholdSource: string;
  provenance: string[];
  recordIds?: string[];
  failureReason?: string;
}): SoakCriterionResult {
  return createSoakCriterion({
    id: input.id,
    mode: input.mode,
    status: input.passed ? 'passed' : 'failed',
    summary: input.summary,
    observed: input.observed,
    threshold: {
      description: input.threshold,
      source: input.thresholdSource,
    },
    provenance: {
      sources: input.provenance,
      ...(input.recordIds ? { recordIds: input.recordIds } : {}),
    },
    ...(!input.passed
      ? { failureReason: input.failureReason ?? input.summary }
      : {}),
  });
}

function notEvaluated(input: {
  id: SoakCriterionId;
  mode: SoakRunMode;
  summary: string;
  observed?: JsonObject;
  threshold: string;
  thresholdSource: string;
  provenance: string[];
  failureReason: string;
}): SoakCriterionResult {
  return createSoakCriterion({
    id: input.id,
    mode: input.mode,
    status: 'not_evaluated',
    summary: input.summary,
    observed: input.observed ?? {},
    threshold: {
      description: input.threshold,
      source: input.thresholdSource,
    },
    provenance: { sources: input.provenance },
    failureReason: input.failureReason,
  });
}

function countByStatus(records: Array<{ status: string }>): JsonObject {
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.status] = (counts[record.status] ?? 0) + 1;
  return counts;
}

async function captureRuntimeEvidence(personaId: string): Promise<JsonObject> {
  const [activities, mailboxItems, leases, snapshot, events] = await Promise.all([
    listPersonaActivities(personaId),
    listPersonaMailboxItems(personaId),
    listPersonaLeaseRecords(personaId),
    inspectAndReconcilePersonaRuntime(personaId, { recentEventLimit: 0 }),
    readPersonaRuntimeEvents(personaId),
  ]);
  return {
    activityStatuses: countByStatus(activities),
    mailboxStatuses: countByStatus(mailboxItems),
    leaseStatuses: countByStatus(leases),
    activeLeaseCount: leases.filter(lease => lease.status === 'active').length,
    lifecycleState: snapshot?.projection.lifecycleState ?? 'missing',
    stuck: snapshot?.projection.stuck ?? false,
    eventCount: events.length,
    firstEventSeq: events[0]?.seq ?? null,
    lastEventSeq: events.at(-1)?.seq ?? null,
  };
}

async function captureRuntimeEvidenceSafely(personaId: string): Promise<JsonObject> {
  try {
    return await captureRuntimeEvidence(personaId);
  } catch (error) {
    return {
      captureError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeFaultEvidence(input: {
  personaId: string;
  day: number;
  kind: SoakFaultKind;
  run: () => Promise<JsonObject>;
}): Promise<SoakFaultEvidence> {
  const id = `day-${input.day}:${input.kind}`;
  let before: JsonObject = { captured: false };
  try {
    before = await captureRuntimeEvidence(input.personaId);
    const fault = await input.run();
    const after = await captureRuntimeEvidence(input.personaId);
    return {
      id,
      day: input.day,
      kind: input.kind,
      status: 'passed',
      before,
      fault,
      after,
      provenance: [
        'production mailbox/activity/lease stores',
        'inspectAndReconcilePersonaRuntime',
        'production fault handler',
      ],
    };
  } catch (error) {
    return {
      id,
      day: input.day,
      kind: input.kind,
      status: 'failed',
      before,
      fault: {
        attempted: true,
      },
      after: await captureRuntimeEvidenceSafely(input.personaId),
      provenance: [
        'production mailbox/activity/lease stores',
        'inspectAndReconcilePersonaRuntime',
        'production fault handler',
      ],
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function reconcileWorkload(input: {
  workload: SoakActivity[];
  personaId: string;
  behaviorBindingId: string;
  behaviorRevisionId: string;
  activities: PersonaActivity[];
  mailboxItems: Awaited<ReturnType<typeof listPersonaMailboxItems>>;
}): WorkloadReconciliationEvidence {
  const result: WorkloadReconciliationEvidence = {
    attempted: input.workload.length,
    accepted: 0,
    completed: 0,
    failed: 0,
    duplicate: 0,
    unresolved: 0,
    missingSourceIds: [],
    duplicateSourceIds: [],
    nonterminalSourceIds: [],
    mailboxLinkMismatchSourceIds: [],
    identityMismatchSourceIds: [],
  };

  for (const workloadItem of input.workload) {
    const steering = workloadItem.ingress.admission === 'steering';
    const activitySourceId = workloadSourceId(workloadItem, steering ? '-host' : '');
    const relatedSourceId = steering ? workloadSourceId(workloadItem, '-related') : undefined;
    const activities = input.activities.filter(
      activity => activity.source.sourceId === activitySourceId,
    );
    const unexpectedRelatedActivities = relatedSourceId
      ? input.activities.filter(activity => activity.source.sourceId === relatedSourceId)
      : [];
    const hostMailboxItems = input.mailboxItems.filter(
      item => item.source.sourceId === activitySourceId,
    );
    const relatedMailboxItems = relatedSourceId
      ? input.mailboxItems.filter(item => item.source.sourceId === relatedSourceId)
      : [];
    const expectedMailboxItems = [...hostMailboxItems, ...relatedMailboxItems];
    const expectedMailboxCount = steering ? 2 : 1;

    if (
      expectedMailboxItems.length === expectedMailboxCount
      && expectedMailboxItems.every(item => item.status !== 'rejected')
    ) {
      result.accepted += 1;
    }

    if (
      activities.length === 0
      || hostMailboxItems.length === 0
      || (steering && relatedMailboxItems.length === 0)
    ) {
      result.missingSourceIds.push(activitySourceId);
      result.unresolved += 1;
      continue;
    }
    if (
      activities.length !== 1
      || unexpectedRelatedActivities.length !== 0
      || hostMailboxItems.length !== 1
      || relatedMailboxItems.length !== (steering ? 1 : 0)
    ) {
      result.duplicateSourceIds.push(activitySourceId);
      result.duplicate += 1;
      continue;
    }

    const activity = activities[0];
    const hostMailboxItem = hostMailboxItems[0];
    const relatedMailboxItem = relatedMailboxItems[0];
    const identityMatches = activity.personaId === input.personaId
      && expectedMailboxItems.every(item => item.personaId === input.personaId)
      && activity.behaviorId === input.behaviorBindingId
      && activity.behaviorRevisionId === input.behaviorRevisionId;
    if (!identityMatches) result.identityMismatchSourceIds.push(activitySourceId);

    const mailboxLinkMatches = hostMailboxItem.claimedActivityId === activity.id
      && (
        !relatedMailboxItem
        || (
          relatedMailboxItem.targetActivityId === activity.id
          && relatedMailboxItem.deliveryStatus === 'delivered'
        )
      );
    if (!mailboxLinkMatches) {
      result.mailboxLinkMismatchSourceIds.push(activitySourceId);
    }

    if (activity.status === 'error' || activity.status === 'cancelled') {
      result.failed += 1;
    } else if (activity.status !== 'completed') {
      result.nonterminalSourceIds.push(activitySourceId);
      result.unresolved += 1;
    } else if (identityMatches && mailboxLinkMatches) {
      result.completed += 1;
    } else {
      result.unresolved += 1;
    }
  }

  return result;
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
): Promise<JsonObject> {
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
    let staleCompletionRejected = false;
    try {
      await completePersonaActivity({ ...fenceForClaim(first), status: 'completed' });
    } catch {
      staleCompletionRejected = true;
    }
    if (!staleCompletionRejected) {
      throw new Error('An expired lease owner completed work after fail-closed recovery.');
    }
    return {
      activityId: first.activity.id,
      firstLeaseId: first.lease.id,
      firstFencingToken: first.lease.fencingToken,
      recovered: false,
      terminalStatus: activity.status,
      expiredLeaseStatus: expiredLease?.status ?? 'missing',
      staleCompletionRejected,
    };
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
      recovered: {
        activityId: recovered.activity.id,
        token: recovered.lease.fencingToken,
        recovered: recovered.recovered,
      },
      now: clock.now(),
    })}`);
  }
  let staleCompletionRejected = false;
  try {
    await completePersonaActivity({ ...fenceForClaim(first), status: 'completed' });
  } catch {
    staleCompletionRejected = true;
  }
  if (!staleCompletionRejected) {
    throw new Error('The stale lease owner completed work after a higher fence was acquired.');
  }
  await completePersonaActivity({ ...fenceForClaim(recovered), status: 'completed' });
  return {
    activityId: first.activity.id,
    firstLeaseId: first.lease.id,
    recoveredLeaseId: recovered.lease.id,
    firstFencingToken: first.lease.fencingToken,
    recoveredFencingToken: recovered.lease.fencingToken,
    recovered: true,
    staleCompletionRejected,
    terminalStatus: 'completed',
  };
}

async function exerciseConcurrentClaimant(personaId: string, token: string): Promise<JsonObject> {
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
  return {
    fulfilledAttempts: attempts.filter(attempt => attempt.status === 'fulfilled').length,
    successfulClaimCount: claims.length,
    activityId: claims[0].activity.id,
    leaseId: claims[0].lease.id,
    fencingToken: claims[0].lease.fencingToken,
    terminalStatus: 'completed',
  };
}

async function exerciseGracefulRestart(
  dispatcher: PersonaFlowDispatcher,
  makeDispatcher: () => PersonaFlowDispatcher,
  personaId: string,
  token: string,
): Promise<{ dispatcher: PersonaFlowDispatcher; evidence: JsonObject }> {
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
  return {
    dispatcher: restarted,
    evidence: {
      dispatchId: submission.dispatch.id,
      activityId: record.activityId ?? null,
      beforeState: submission.dispatch.state,
      afterState: record.state,
      durableDrainCompleted: true,
    },
  };
}

async function exerciseAdministrativeRecovery(personaId: string): Promise<JsonObject> {
  const recovered = await recoverPersonaRuntime({ personaId, confirmation: 'RECOVER' });
  if (recovered.lifecycleState !== 'idle' || recovered.closedActivityIds.length > 0) {
    throw new Error('Administrative recovery did not leave an idle, coherent runtime.');
  }
  return {
    lifecycleState: recovered.lifecycleState,
    closedActivityIds: recovered.closedActivityIds,
  };
}

export async function exerciseHardCrashProcessBoundary(seed: number): Promise<JsonObject> {
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
    const before = await first.request<ProcessClaim | null>({
      type: 'claim', personaId: created.persona.id, ttlMs: 1_000,
    });
    if (!before) throw new Error('Hard-crash fault could not claim its Activity.');
    await first.kill();
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const restarted = await restartPersonaProcess(environment);
    clients.push(restarted);
    const after = await restarted.request<ProcessClaim | null>({
      type: 'claim', personaId: created.persona.id, ttlMs: 1_000,
    });
    const runtime = await restarted.request<ProcessRuntimeSnapshot>({
      type: 'inspect', personaId: created.persona.id,
    });
    const activity = runtime.activities.find((candidate) => candidate.id === before.activity.id);
    const mailboxItem = runtime.mailboxItems.find(
      (candidate) => candidate.id === before.mailboxItem.id,
    );
    const lease = runtime.lease;
    if (
      after !== null
      || !activity
      || activity.status !== 'error'
      || !activity.error?.includes('automatic replay was suppressed')
      || !mailboxItem
      || mailboxItem.status !== 'rejected'
      || mailboxItem.claimedActivityId !== before.activity.id
      || !lease
      || lease.activityId !== before.activity.id
      || lease.status !== 'expired'
      || lease.fencingToken !== before.lease.fencingToken
    ) {
      throw new Error(`Hard-crash process recovery did not fail closed coherently: ${JSON.stringify({
        replayedClaim: after,
        activity,
        mailboxItem,
        lease,
      })}`);
    }
    return {
      personaId: created.persona.id,
      activityId: before.activity.id,
      mailboxItemId: before.mailboxItem.id,
      fencingToken: before.lease.fencingToken,
      replayedClaim: false,
      terminalStatus: activity.status,
      mailboxStatus: mailboxItem.status,
      leaseStatus: lease.status,
      failClosed: true,
    };
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

async function exerciseLearningRollback(seed: number): Promise<LearningRollbackEvidence> {
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
  return {
    evaluated: true,
    personaId: setup.persona.id,
    behaviorId: binding.id,
    proposalId: proposal.id,
    metricId: behaviorOutcomeMetricId(proposal.id),
    baseRevisionId: baseRevision.id,
    activatedRevisionId: activated.activatedRevisionId,
    ...(currentBinding?.activeRevisionId
      ? { finalRevisionId: currentBinding.activeRevisionId }
      : {}),
    ...(currentProposal?.status ? { proposalStatus: currentProposal.status } : {}),
    ...(metric?.verdict ? { metricVerdict: metric.verdict } : {}),
    baselineSamples: BEHAVIOR_OUTCOME_MIN_SAMPLES,
    regressionSamples: BEHAVIOR_OUTCOME_MIN_SAMPLES,
    ...(metric?.autoRollbackAt ? { autoRollbackAt: metric.autoRollbackAt } : {}),
  };
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
  const exactAcceptanceConfiguration = options.days === FULL_GATE_DAYS
    && options.activitiesPerDay === FULL_GATE_ACTIVITIES_PER_DAY;
  const runMode = options.runMode
    ?? (exactAcceptanceConfiguration ? 'acceptance' : 'smoke');
  const fullGate = runMode !== 'smoke';
  const wallStartedAt = Date.now();
  const startedAt = wallStartedAt + 1_000;
  const commitSha = options.commitSha
    ?? process.env.PERSONA_SOAK_COMMIT
    ?? process.env.GITHUB_SHA
    ?? 'unreported';
  const runId = options.runId
    ?? process.env.PERSONA_SOAK_RUN_ID
    ?? `local-${process.pid}-${options.seed}-${wallStartedAt}`;
  const clock = new VirtualPersonaRuntimeClock(startedAt, 100_000);
  const workload = generatePersonaSoakWorkload({ ...options, startAt: startedAt });
  const faults = defaultFaultSchedule(options.days);
  const expectedFaultIds = faults.map(fault => `day-${fault.day}:${fault.kind}`);
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
      const primaryBinding = bundle.behaviorBindings.find(candidate => candidate.slotKey === 'primary');
      if (!primaryBinding) throw new Error('Runtime-backed soak Persona has no Primary binding.');
      // Factory Role snapshots can differ from the Persona's authored Core.
      // Resolve the same immutable revision that production admission pins,
      // before fixing the expected identity for every generated Activity.
      const coreRevision = await resolvePersonaCoreRevision(personaId);
      if (coreRevision.behaviorId !== primaryBinding.id) {
        throw new Error('Runtime-backed soak Core does not belong to its Primary binding.');
      }
      const behaviorBindingId = primaryBinding.id;
      const behaviorRevisionId = coreRevision.id;
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
      const faultEvidence: SoakFaultEvidence[] = [];
      const persistedLeaseOverlapPairs = new Set<string>();

      for (let day = 1; day <= options.days; day += 1) {
        debug(`day ${day} started`);
        const dailyWorkload = workload.filter((activity) => activity.day === day);
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
          let evidence: SoakFaultEvidence;
          switch (fault.kind) {
            case 'lease-expiry':
              evidence = await executeFaultEvidence({
                personaId,
                day,
                kind: fault.kind,
                run: () => exerciseLeaseExpiry(personaId, clock, token),
              });
              break;
            case 'concurrent-claimant':
              evidence = await executeFaultEvidence({
                personaId,
                day,
                kind: fault.kind,
                run: () => exerciseConcurrentClaimant(personaId, token),
              });
              break;
            case 'graceful-restart':
              evidence = await executeFaultEvidence({
                personaId,
                day,
                kind: fault.kind,
                run: async () => {
                  const restarted = await exerciseGracefulRestart(
                    dispatcher, makeDispatcher, personaId, token,
                  );
                  dispatcher = restarted.dispatcher;
                  return restarted.evidence;
                },
              });
              break;
            case 'administrative-recovery':
              evidence = await executeFaultEvidence({
                personaId,
                day,
                kind: fault.kind,
                run: () => exerciseAdministrativeRecovery(personaId),
              });
              break;
            case 'hard-crash':
              if (fullGate) {
                evidence = await executeFaultEvidence({
                  personaId,
                  day,
                  kind: fault.kind,
                  run: () => exerciseHardCrashProcessBoundary(options.seed),
                });
                hardCrashExecuted = evidence.status === 'passed';
              } else {
                const snapshot = await captureRuntimeEvidenceSafely(personaId);
                evidence = {
                  id: `day-${day}:${fault.kind}`,
                  day,
                  kind: fault.kind,
                  status: 'not_evaluated',
                  before: snapshot,
                  fault: { attempted: false },
                  after: snapshot,
                  provenance: ['personaProcessBoundaryHarness'],
                  failureReason: 'The OS process-boundary scenario is reserved for acceptance runs.',
                };
              }
              break;
            default: {
              const exhaustive: never = fault.kind;
              throw new Error(`Unsupported soak fault: ${exhaustive}`);
            }
          }
          faultEvidence.push(evidence);
          if (evidence.status === 'passed') executedFaults.push(fault.kind);
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

        const [storage, activities, mailboxItems, checkpointEvents] = await Promise.all([
          getPersonaStorageStats(personaId),
          listPersonaActivities(personaId),
          listPersonaMailboxItems(personaId),
          readPersonaRuntimeEvents(personaId),
        ]);
        const checkpointSequenceContinuous = checkpointEvents.every((event, index) => (
          index === 0 || event.seq === checkpointEvents[index - 1].seq + 1
        ));
        const checkpointEventIdsUnique = new Set(checkpointEvents.map(event => event.eventId)).size
          === checkpointEvents.length;
        const dailyReconciliation = reconcileWorkload({
          workload: dailyWorkload,
          personaId,
          behaviorBindingId,
          behaviorRevisionId,
          activities,
          mailboxItems,
        });
        const eventState = _getPersonaRuntimeEventLogStateForTests(personaId);
        metrics.push({
          day,
          activitiesAttempted: dailyReconciliation.attempted,
          activitiesAccepted: dailyReconciliation.accepted,
          activitiesSucceeded: dailyReconciliation.completed,
          activitiesFailed: dailyReconciliation.failed,
          activitiesDuplicate: dailyReconciliation.duplicate,
          activitiesUnresolved: dailyReconciliation.unresolved,
          recallPrecision: scoreRecallPrecision(recallObservations),
          recallP95Ms: percentile(recallSamples, 0.95),
          residentMemoryBytes: process.memoryUsage().rss,
          eventAppendP95Ms: percentile(appendSamples, 0.95),
          eventLogSegments: eventState?.segmentCount ?? 0,
          eventCount: checkpointEvents.length,
          eventFirstSeq: checkpointEvents[0]?.seq ?? null,
          eventLastSeq: checkpointEvents.at(-1)?.seq ?? null,
          eventSequenceContinuous: checkpointSequenceContinuous,
          eventIdsUnique: checkpointEventIdsUnique,
          collectionCounts: Object.fromEntries(
            Object.entries(storage.kinds).map(([key, value]) => [key, value.total]),
          ),
          collectionUncompactedCounts: Object.fromEntries(
            Object.entries(storage.kinds).map(([key, value]) => [key, value.uncompacted]),
          ),
          faultsScheduled: scheduledFaults.map((fault) => fault.kind),
          faultsExecuted: executedFaults,
          faultEvidenceIds: faultEvidence
            .filter(item => item.day === day)
            .map(item => item.id),
        });
        debug(`day ${day} completed`);
      }

      _setPersonaRuntimeClockForTests(previousClock);
      debug(`starting learning rollback=${Boolean(options.withLearning)}`);
      const learningEvidence: LearningRollbackEvidence = options.withLearning
        ? await exerciseLearningRollback(options.seed)
        : {
            evaluated: false,
            baselineSamples: 0,
            regressionSamples: 0,
          };
      const learning = learningEvidence.evaluated
        && learningEvidence.metricVerdict === 'rolled_back'
        && learningEvidence.finalRevisionId === learningEvidence.baseRevisionId
        && learningEvidence.proposalStatus === 'rolled_back';
      debug(`learning rollback completed=${learning}`);
      _setPersonaRuntimeClockForTests(clock);

      const [activities, mailboxItems, leases, dispatches, runtime] = await Promise.all([
        listPersonaActivities(personaId),
        listPersonaMailboxItems(personaId),
        listPersonaLeaseRecords(personaId),
        dispatcher.list(personaId),
        inspectAndReconcilePersonaRuntime(personaId),
      ]);
      const workloadReconciliation = reconcileWorkload({
        workload,
        personaId,
        behaviorBindingId,
        behaviorRevisionId,
        activities,
        mailboxItems,
      });
      for (const pair of overlappingLeasePairs(leases)) persistedLeaseOverlapPairs.add(pair);
      const splitBrainCount = persistedLeaseOverlapPairs.size;
      const strandedLeaseCount = leases.filter(lease => lease.status === 'active').length;
      const stuckPersonaCount = runtime?.projection.stuck ? 1 : 0;
      const firstMetric = metrics[0];
      const lastMetric = metrics.at(-1)!;
      const firstAppend = firstMetric.eventAppendP95Ms;
      const residentGrowth = lastMetric.residentMemoryBytes - firstMetric.residentMemoryBytes;
      const maxUncompacted = lastMetric.collectionUncompactedCounts;
      const runtimeEvents = await readPersonaRuntimeEvents(personaId);
      const retainedEventSequenceContinuous = runtimeEvents.every((event, index) => (
        index === 0 || event.seq === runtimeEvents[index - 1].seq + 1
      ));
      const eventIdsUnique = new Set(runtimeEvents.map(event => event.eventId)).size
        === runtimeEvents.length;
      const checkpointRangesContinuous = metrics.every((metric, index) => {
        if (
          !metric.eventSequenceContinuous
          || !metric.eventIdsUnique
          || metric.eventCount === 0
          || metric.eventFirstSeq === null
          || metric.eventLastSeq === null
        ) {
          return false;
        }
        if (index === 0) return true;
        const previous = metrics[index - 1];
        return previous.eventLastSeq !== null
          && metric.eventFirstSeq <= previous.eventLastSeq + 1
          && metric.eventLastSeq >= previous.eventLastSeq;
      });
      const eventSequencesContinuous = retainedEventSequenceContinuous
        && checkpointRangesContinuous;
      const actualFaultIds = faultEvidence.map(item => item.id);
      const missingFaultIds = expectedFaultIds.filter(id => !actualFaultIds.includes(id));
      const unexpectedFaultIds = actualFaultIds.filter(id => !expectedFaultIds.includes(id));
      const allScheduledFaultsEvaluated = missingFaultIds.length === 0
        && unexpectedFaultIds.length === 0;
      const failedFaults = faultEvidence.filter(item => item.status === 'failed');
      const unevaluatedFaults = faultEvidence.filter(item => item.status === 'not_evaluated');
      const endedAt = Date.now();
      const runIdentity: SoakRunIdentity = {
        schemaVersion: PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION,
        runId,
        mode: runMode,
        authoritative: runMode === 'acceptance'
          && exactAcceptanceConfiguration
          && Boolean(options.withLearning)
          && commitSha !== 'unreported',
        commitSha,
        seed: options.seed,
        days: options.days,
        activitiesPerDay: options.activitiesPerDay,
        learningEnabled: Boolean(options.withLearning),
        startedAt: new Date(wallStartedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        runner: {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          osRelease: release(),
          cpuModel: cpus()[0]?.model ?? 'unknown',
          logicalCpuCount: cpus().length,
        },
        configuration: {
          gatingMode: options.gatingMode ?? 'report',
          recallSamplesPerDay: RECALL_SAMPLES_PER_DAY,
          eventAppendSamplesPerDay: APPEND_SAMPLES_PER_DAY,
          percentileMethod: 'nearest-rank',
          scheduledFaultIds: expectedFaultIds,
        },
      };
      const workloadPassed = workloadReconciliation.accepted === workloadReconciliation.attempted
        && workloadReconciliation.completed === workloadReconciliation.attempted
        && workloadReconciliation.failed === 0
        && workloadReconciliation.duplicate === 0
        && workloadReconciliation.unresolved === 0;
      const scheduledFaultCriterion = failedFaults.length > 0
        ? criterion({
            id: 'scheduled-fault-recovery',
            mode: runMode,
            passed: false,
            summary: `${failedFaults.length} scheduled fault handlers failed.`,
            observed: {
              scheduled: faults.length,
              evidenced: faultEvidence.length,
              failedIds: failedFaults.map(item => item.id),
              unevaluatedIds: unevaluatedFaults.map(item => item.id),
              missingIds: missingFaultIds,
              unexpectedIds: unexpectedFaultIds,
            },
            threshold: 'Every scheduled fault emits passed before/fault/after evidence.',
            thresholdSource: 'Issue #489 required fix 3',
            provenance: ['faultEvidence', 'production runtime snapshots'],
          })
        : unevaluatedFaults.length > 0 || !allScheduledFaultsEvaluated
          ? notEvaluated({
              id: 'scheduled-fault-recovery',
              mode: runMode,
              summary: 'One or more scheduled fault handlers were not evaluated.',
              observed: {
                scheduled: faults.length,
                evidenced: faultEvidence.length,
                unevaluatedIds: unevaluatedFaults.map(item => item.id),
                missingIds: missingFaultIds,
                unexpectedIds: unexpectedFaultIds,
              },
              threshold: 'Every scheduled fault emits passed before/fault/after evidence.',
              thresholdSource: 'Issue #489 required fix 3',
              provenance: ['faultEvidence', 'production runtime snapshots'],
              failureReason: 'The complete scheduled fault matrix did not execute.',
            })
          : criterion({
              id: 'scheduled-fault-recovery',
              mode: runMode,
              passed: true,
              summary: `All ${faultEvidence.length} scheduled faults executed and recovered.`,
              observed: {
                scheduled: faults.length,
                passedIds: faultEvidence.map(item => item.id),
              },
              threshold: 'Every scheduled fault emits passed before/fault/after evidence.',
              thresholdSource: 'Issue #489 required fix 3',
              provenance: ['faultEvidence', 'production runtime snapshots'],
              recordIds: faultEvidence.map(item => item.id),
            });
      const criteria: SoakCriterionResult[] = [
        criterion({
          id: 'unattended-runtime-throughput',
          mode: runMode,
          passed: workloadPassed,
          summary: `${workloadReconciliation.completed}/${workloadReconciliation.attempted} generated inputs became coherent terminal Activities.`,
          observed: {
            attempted: workloadReconciliation.attempted,
            completed: workloadReconciliation.completed,
          },
          threshold: 'All generated inputs complete; acceptance uses exactly 28 days x 20 activities/day.',
          thresholdSource: 'Issue #459 acceptance criterion 1',
          provenance: ['generatePersonaSoakWorkload', 'listPersonaActivities'],
        }),
        criterion({
          id: 'persisted-workload-reconciliation',
          mode: runMode,
          passed: workloadPassed,
          summary: 'Generated source IDs were reconciled to the expected ingress mailbox records and one terminal Activity.',
          observed: {
            ...workloadReconciliation,
          },
          threshold: 'Every generated input is accepted; no missing, duplicate, nonterminal, false-success, mailbox-link, Persona, or revision mismatch.',
          thresholdSource: 'Issue #489 required fix 1 and acceptance criterion 2',
          provenance: ['listPersonaMailboxItems', 'listPersonaActivities', 'active Behavior binding'],
        }),
        scheduledFaultCriterion,
        criterion({
          id: 'recall-precision-stability',
          mode: runMode,
          passed: lastMetric.recallPrecision >= firstMetric.recallPrecision - 0.05,
          summary: `Day 1=${firstMetric.recallPrecision.toFixed(4)}, day ${options.days}=${lastMetric.recallPrecision.toFixed(4)}.`,
          observed: {
            day1: firstMetric.recallPrecision,
            final: lastMetric.recallPrecision,
            allowedAbsoluteDrop: 0.05,
          },
          threshold: 'Final recall precision is within 5 percentage points of day 1.',
          thresholdSource: 'Issue #459 acceptance criterion 2',
          provenance: ['searchPersonaMemory lexical production path', 'deterministic ground-truth IDs'],
        }),
        criterion({
          id: 'runtime-scale-recall-latency',
          mode: runMode,
          passed: lastMetric.recallP95Ms < 150,
          summary: `Measured production search p95=${lastMetric.recallP95Ms.toFixed(2)} ms at soak scale; the controlled 50k gate runs separately.`,
          observed: {
            p95Ms: lastMetric.recallP95Ms,
            samples: RECALL_SAMPLES_PER_DAY,
            memoryItems: lastMetric.collectionCounts.memoryItems ?? 0,
          },
          threshold: 'p95 is strictly less than 150 ms; the release-scale 50k fixture is validated by the controlled benchmark.',
          thresholdSource: 'Issue #459 acceptance criterion 3 and issue #489 required fix 6',
          provenance: ['performance.now', 'searchPersonaMemory', 'nearest-rank percentile'],
        }),
        notEvaluated({
          id: 'bounded-detailed-runtime-state',
          mode: runMode,
          summary: 'Actual collection totals and uncompacted counts were recorded without inventing an acceptance cap.',
          observed: {
            finalCollectionCounts: lastMetric.collectionCounts,
            finalUncompactedCounts: maxUncompacted,
            eventLogSegments: lastMetric.eventLogSegments,
          },
          threshold: 'Reviewer-approved numeric steady-state bounds for every applicable collection.',
          thresholdSource: 'Issue #459 says bounded steady state but supplies no numeric collection contract.',
          provenance: ['getPersonaStorageStats', 'runtime-event manifest'],
          failureReason: 'No committed numeric collection-bound contract exists.',
        }),
        notEvaluated({
          id: 'flat-event-append-cost',
          mode: runMode,
          summary: `Observed day-1 p95=${firstAppend.toFixed(2)} ms and final p95=${lastMetric.eventAppendP95Ms.toFixed(2)} ms.`,
          observed: {
            day1P95Ms: firstAppend,
            finalP95Ms: lastMetric.eventAppendP95Ms,
            samplesPerDay: APPEND_SAMPLES_PER_DAY,
          },
          threshold: 'Reviewer-approved numeric definition of flat append cost.',
          thresholdSource: 'Issue #459 says flat but supplies no tolerance or statistical contract.',
          provenance: ['performance.now', 'appendPersonaRuntimeEvent', 'nearest-rank percentile'],
          failureReason: 'No committed numeric event-append flatness contract exists.',
        }),
        criterion({
          id: 'runtime-event-continuity',
          mode: runMode,
          passed: eventSequencesContinuous && eventIdsUnique,
          summary: `${runtimeEvents.length} retained production runtime events and all daily retention checkpoints had continuous sequence ranges and unique IDs.`,
          observed: {
            eventCount: runtimeEvents.length,
            firstSeq: runtimeEvents[0]?.seq ?? null,
            lastSeq: runtimeEvents.at(-1)?.seq ?? null,
            retainedSequenceContinuous: retainedEventSequenceContinuous,
            checkpointRangesContinuous,
            eventIdsUnique,
            dailyRanges: metrics.map(metric => ({
              day: metric.day,
              count: metric.eventCount,
              firstSeq: metric.eventFirstSeq,
              lastSeq: metric.eventLastSeq,
              continuous: metric.eventSequenceContinuous,
              idsUnique: metric.eventIdsUnique,
            })),
          },
          threshold: 'Each retained range is internally continuous and every daily range overlaps or directly follows the prior checkpoint; event IDs are unique.',
          thresholdSource: 'Issue #489 required fix 3',
          provenance: ['readPersonaRuntimeEvents', 'persisted segmented JSONL event log'],
        }),
        criterion({
          id: 'zero-split-brain',
          mode: runMode,
          passed: splitBrainCount === 0,
          summary: `${splitBrainCount} overlapping lease acquisitions were found in persisted history.`,
          observed: { splitBrainCount },
          threshold: 'Zero overlapping live lease intervals for one Persona.',
          thresholdSource: 'Issue #459 acceptance criterion 6',
          provenance: ['listPersonaLeaseRecords', 'pre-pruning overlap observations'],
        }),
        criterion({
          id: 'zero-stranded-or-stuck',
          mode: runMode,
          passed: strandedLeaseCount === 0 && stuckPersonaCount === 0,
          summary: `Active leases=${strandedLeaseCount}; stuck Personas=${stuckPersonaCount}.`,
          observed: { strandedLeaseCount, stuckPersonaCount },
          threshold: 'Zero stranded leases and zero stuck Personas after the run.',
          thresholdSource: 'Issue #459 acceptance criterion 7',
          provenance: ['listPersonaLeaseRecords', 'inspectAndReconcilePersonaRuntime'],
        }),
        notEvaluated({
          id: 'resident-memory-bound',
          mode: runMode,
          summary: `Observed resident-memory growth=${residentGrowth} bytes.`,
          observed: {
            day1Bytes: firstMetric.residentMemoryBytes,
            finalBytes: lastMetric.residentMemoryBytes,
            growthBytes: residentGrowth,
          },
          threshold: 'Reviewer-approved resident-memory ceiling or growth tolerance.',
          thresholdSource: 'Issue #459 says bounded but supplies no numeric memory contract.',
          provenance: ['process.memoryUsage().rss at daily checkpoints'],
          failureReason: 'No committed numeric resident-memory bound exists.',
        }),
        options.withLearning
          ? criterion({
              id: 'learning-auto-rollback',
              mode: runMode,
              passed: learning,
              summary: learning
                ? 'A persisted regression rolled the active Behavior binding back to its base revision.'
                : 'The production outcome metric did not restore the base revision.',
              observed: {
                evaluated: learningEvidence.evaluated,
                personaId: learningEvidence.personaId ?? null,
                behaviorId: learningEvidence.behaviorId ?? null,
                proposalId: learningEvidence.proposalId ?? null,
                metricId: learningEvidence.metricId ?? null,
                baseRevisionId: learningEvidence.baseRevisionId ?? null,
                activatedRevisionId: learningEvidence.activatedRevisionId ?? null,
                finalRevisionId: learningEvidence.finalRevisionId ?? null,
                proposalStatus: learningEvidence.proposalStatus ?? null,
                metricVerdict: learningEvidence.metricVerdict ?? null,
                baselineSamples: learningEvidence.baselineSamples,
                regressionSamples: learningEvidence.regressionSamples,
                autoRollbackAt: learningEvidence.autoRollbackAt ?? null,
              },
              threshold: 'Regression verdict is rolled_back and the active binding returns to the base revision.',
              thresholdSource: 'Issue #459 acceptance criterion 8',
              provenance: ['behavior proposal store', 'outcome metric store', 'Behavior binding store'],
            })
          : notEvaluated({
              id: 'learning-auto-rollback',
              mode: runMode,
              summary: 'Learning was disabled for this run.',
              threshold: 'Acceptance runs must activate, regress, and automatically roll back a real proposal.',
              thresholdSource: 'Issue #459 acceptance criterion 8',
              provenance: ['run configuration'],
              failureReason: 'Run with --with-learning to evaluate automatic rollback.',
            }),
        fullGate
          ? criterion({
              id: 'os-process-hard-crash-recovery',
              mode: runMode,
              passed: hardCrashExecuted,
              summary: hardCrashExecuted
                ? 'A killed child process safely terminalized uncertain work without replay or a stranded lease.'
                : 'The process-boundary fault did not produce passed evidence.',
              observed: {
                hardCrashExecuted,
                evidenceIds: faultEvidence
                  .filter(item => item.kind === 'hard-crash')
                  .map(item => item.id),
              },
              threshold: 'Killed-worker recovery fails closed without replay, duplicate completion, or a live lease.',
              thresholdSource: 'Issue #489 required fix 3',
              provenance: ['personaProcessBoundaryHarness', 'child-process persisted runtime snapshot'],
            })
          : notEvaluated({
              id: 'os-process-hard-crash-recovery',
              mode: runMode,
              summary: 'The process-boundary crash is non-authoritative in smoke mode.',
              threshold: 'Acceptance runs execute a real child-process kill and restart.',
              thresholdSource: 'Issue #489 required fix 3',
              provenance: ['run configuration'],
              failureReason: 'Only the authoritative acceptance mode requires the OS-process scenario.',
            }),
      ];

      return {
        schemaVersion: PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION,
        runIdentity,
        seed: options.seed,
        days: options.days,
        activities: workloadReconciliation.completed,
        ingressLabels: [...new Set(workload.map(activity => activity.ingress.label))].sort(),
        splitBrainCount,
        strandedLeaseCount,
        stuckPersonaCount,
        learning: options.withLearning ? learning ? 'passed' : 'failed' : 'skipped',
        runtimeEvidence: {
          workspaceId,
          personaId,
          behaviorBindingId,
          behaviorRevisionId,
          persistedActivities: activities.length,
          persistedMailboxItems: mailboxItems.length,
          persistedLeaseAcquisitions: leases.length,
          persistedDispatches: dispatches.length,
          modelCalls,
        },
        workloadReconciliation,
        faultEvidence,
        learningEvidence,
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
    const jsonlRecords = [
      {
        recordType: 'run',
        schemaVersion: summary.schemaVersion,
        runIdentity: summary.runIdentity,
      },
      ...summary.metrics.map(metric => ({ recordType: 'daily_metric', metric })),
      {
        recordType: 'workload_reconciliation',
        reconciliation: summary.workloadReconciliation,
      },
      ...summary.faultEvidence.map(fault => ({ recordType: 'fault', fault })),
      ...summary.criteria.map(criterionRecord => ({
        recordType: 'criterion',
        criterion: criterionRecord,
      })),
    ];
    await fs.writeFile(
      path.join(options.outputDirectory, 'persona-soak.json'),
      `${stableJsonStringify(summary, 2)}\n`,
    );
    await fs.writeFile(
      path.join(options.outputDirectory, 'persona-soak.jsonl'),
      `${jsonlRecords.map(record => stableJsonStringify(record)).join('\n')}\n`,
    );
    await fs.writeFile(
      path.join(options.outputDirectory, 'persona-soak.md'),
      renderSoakReport(
        summary.runIdentity,
        summary.metrics,
        summary.criteria,
        summary.workloadReconciliation,
      ),
    );
  }

  const enforcementFailures = soakEnforcementFailures(summary);
  if (options.gatingMode === 'enforce' && enforcementFailures.length > 0) {
    throw new Error(
      `Persona soak evidence gate failed:\n- ${enforcementFailures.join('\n- ')}`,
    );
  }
  if (options.gatingMode === 'warn' && enforcementFailures.length > 0) {
    process.stderr.write(
      `[persona-soak] evidence warnings:\n- ${enforcementFailures.join('\n- ')}\n`,
    );
  }
  return summary;
}
