import {
  claimNextPersonaActivity,
  completePersonaActivity,
  routePersonaMailboxItem,
} from '@/backend/services/enduringAgents';
import { resolvePersonaCoreRevision } from '@/backend/services/enduringAgents/personaCoreResolver';
import { listPersonaActivities, listPersonaMailboxItems } from '@/backend/services/enduringAgents/store';
import { runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from '../fixtures/personaFactory';
import { PERSONA_INGRESS_MATRIX } from '../personaIngressMatrix';
import {
  assertValidFaultResult,
  exerciseHardCrashProcessBoundary,
  reconcileWorkload,
  runPersonaSoak,
} from './soakHarness';
import { VirtualPersonaRuntimeClock } from './virtualClock';
import { generatePersonaSoakWorkload } from './workloadGenerator';

// Keep Jest below the 60-minute workflow cap so harness teardown and artifact upload can finish.
jest.setTimeout(50 * 60 * 1_000);

describe('deterministic Persona soak harness', () => {
  it('reconciles the actual authored Core revision while rejecting a stale Role revision', async () => {
    await runWithWorkspace(`soak-core-revision-${process.pid}`, async () => {
      const bundle = await createPersonaFromRole({ name: 'Soak Core identity regression' });
      const primary = bundle.behaviorBindings.find(binding => binding.slotKey === 'primary');
      if (!primary) throw new Error('Expected a Primary binding.');
      const core = await resolvePersonaCoreRevision(bundle.persona.id);
      // The test Role deliberately authors a Core distinct from its Primary
      // template, reproducing the preexisting smoke harness assumption.
      expect(core.id).not.toBe(primary.activeRevisionId);
      expect(core.behaviorId).toBe(primary.id);
      const workload = generatePersonaSoakWorkload({ days: 1, activitiesPerDay: 1, seed: 459 });
      const input = workload[0];
      const sourceId = `soak-workload-${input.id}`;
      await routePersonaMailboxItem({
        personaId: bundle.persona.id,
        idempotencyKey: input.id,
        kind: input.ingress.mailboxKind,
        source: { kind: input.ingress.sourceKind, sourceId },
        summary: 'Verify the resolved authored Core identity.',
      });
      const claim = await claimNextPersonaActivity({ personaId: bundle.persona.id, ttlMs: 30_000 });
      if (!claim) throw new Error('Expected the generated Activity to be claimed.');
      expect(claim.activity.behaviorRevisionId).toBe(core.id);
      await completePersonaActivity({
        workspaceId: claim.lease.workspaceId,
        personaId: claim.activity.personaId,
        activityId: claim.activity.id,
        leaseId: claim.lease.id,
        holderId: claim.lease.holderId,
        fencingToken: claim.lease.fencingToken,
        status: 'completed',
      });
      const observation = {
        workload,
        personaId: bundle.persona.id,
        behaviorBindingId: primary.id,
        behaviorRevisionId: core.id,
        activities: await listPersonaActivities(bundle.persona.id),
        mailboxItems: await listPersonaMailboxItems(bundle.persona.id),
      };
      expect(reconcileWorkload(observation)).toMatchObject({
        attempted: 1, accepted: 1, completed: 1, unresolved: 0,
        identityMismatchSourceIds: [], mailboxLinkMismatchSourceIds: [],
      });
      expect(reconcileWorkload({ ...observation, behaviorRevisionId: primary.activeRevisionId })).toMatchObject({
        completed: 0, unresolved: 1, identityMismatchSourceIds: [sourceId],
      });
      expect(reconcileWorkload({
        ...observation,
        mailboxItems: observation.mailboxItems.map(item => ({ ...item, claimedActivityId: 'unrelated_activity' })),
      })).toMatchObject({ completed: 0, unresolved: 1, mailboxLinkMismatchSourceIds: [sourceId] });
    });
  });

  it('generates byte-identical seeded schedules with weekly ingress coverage', () => {
    const options = { days: 28, activitiesPerDay: 20, seed: 459 };
    const first = generatePersonaSoakWorkload(options);
    expect(JSON.stringify(first)).toBe(JSON.stringify(generatePersonaSoakWorkload(options)));
    expect(first).toHaveLength(560);
    for (let week = 0; week < 4; week += 1) {
      const labels = new Set(first.filter((activity) => activity.day > week * 7 && activity.day <= (week + 1) * 7).map((activity) => activity.ingress.label));
      expect(labels).toEqual(new Set(PERSONA_INGRESS_MATRIX.map((entry) => entry.label)));
    }
  });

  it('runs quick or full simulated time and enforces runtime health invariants', async () => {
    const quick = process.env.PERSONA_SOAK_FULL !== '1';
    const days = Number(process.env.PERSONA_SOAK_DAYS ?? (quick ? 3 : 28));
    const activitiesPerDay = Number(process.env.PERSONA_SOAK_ACTIVITIES_PER_DAY ?? (quick ? 5 : 20));
    const summary = await runPersonaSoak({
      days,
      activitiesPerDay,
      seed: Number(process.env.PERSONA_SOAK_SEED ?? 459),
      outputDirectory: process.env.PERSONA_SOAK_OUTPUT,
      gatingMode: 'enforce',
      withLearning: process.env.PERSONA_SOAK_WITH_LEARNING === '1',
      ...(process.env.PERSONA_SOAK_COMMIT
        ? { commitSha: process.env.PERSONA_SOAK_COMMIT }
        : {}),
      ...(process.env.PERSONA_SOAK_RUN_ID
        ? { runId: process.env.PERSONA_SOAK_RUN_ID }
        : {}),
      runMode: quick ? 'smoke' : process.env.PERSONA_SOAK_MODE === 'infrastructure' ? 'infrastructure' : 'acceptance',
    });
    expect(summary.activities).toBe(days * activitiesPerDay);
    expect(summary.splitBrainCount).toBe(0);
    expect(summary.strandedLeaseCount).toBe(0);
    expect(summary.stuckPersonaCount).toBe(0);
    expect(summary.runtimeEvidence).toMatchObject({
      persistedActivities: expect.any(Number),
      persistedMailboxItems: expect.any(Number),
      persistedLeaseAcquisitions: expect.any(Number),
      retainedLeaseRecords: expect.any(Number),
      observedFencingTokenCount: expect.any(Number),
      leaseAcquisitionProofSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      modelCalls: expect.any(Number),
    });
    expect(summary.workloadReconciliation).toMatchObject({
      attempted: days * activitiesPerDay,
      completed: days * activitiesPerDay,
      failed: 0,
      duplicate: 0,
      unresolved: 0,
    });
    expect(summary.runtimeEvidence).toMatchObject({
      behaviorBindingId: expect.any(String),
      behaviorRevisionId: expect.any(String),
    });
    expect(summary.runtimeEvidence.persistedActivities).toBeGreaterThanOrEqual(summary.activities);
    expect(summary.runtimeEvidence.persistedMailboxItems).toBeGreaterThanOrEqual(summary.activities);
    expect(summary.runtimeEvidence.persistedLeaseAcquisitions).toBeGreaterThanOrEqual(summary.activities);
    expect(summary.runtimeEvidence.retainedLeaseRecords).toBeLessThanOrEqual(50);
    expect(summary.runtimeEvidence.observedFencingTokenCount)
      .toBe(summary.runtimeEvidence.persistedLeaseAcquisitions);
    expect(summary.metrics.every(metric => (
      metric.leaseHistoryPruning.afterCount <= 50
      && metric.leaseHistoryPruning.retainedUnverifiable === 0
      && metric.leaseHistoryPruning.observedAcquisitionCount
        === metric.leaseHistoryPruning.observedFencingTokenCount
      && /^[0-9a-f]{64}$/.test(metric.leaseHistoryPruning.prePruneSnapshotSha256)
    ))).toBe(true);
    expect(summary.runtimeEvidence.modelCalls).toBeGreaterThan(0);
    expect(summary.metrics.every((metric) => metric.recallP95Ms > 0)).toBe(true);
    expect(summary.metrics.every((metric) => metric.eventAppendP95Ms > 0)).toBe(true);
    expect(summary.criteria.filter((criterion) => criterion.status === 'failed')).toEqual([]);
    for (const id of [
      'bounded-detailed-runtime-state',
      'flat-event-append-cost',
      'resident-memory-bound',
    ]) {
      expect(summary.criteria.find(criterion => criterion.id === id)).toMatchObject({
        status: 'passed',
        threshold: {
          description: expect.any(String),
          source: 'Issue #489 acceptance repair numeric contract (2026-09-06)',
        },
      });
    }
    expect(summary.faultEvidence.find((fault) => fault.kind === 'lease-expiry')).toMatchObject({
      status: 'passed',
      fault: {
        recovered: true,
        holderChanged: true,
        terminalStatus: 'completed',
        staleCompletionRejected: true,
        terminalActivityCount: 1,
        terminalMailboxCount: 1,
        terminalSuccessEventCount: 1,
      },
    });
  });

  it('rejects a non-recovery result even when the fault handler returned normally', () => {
    expect(() => assertValidFaultResult('lease-expiry', {
      recovered: false,
      terminalStatus: 'error',
      staleCompletionRejected: true,
    })).toThrow(/invalid lease-expiry recovery evidence/i);
  });

  it('absorbs real restart windows without losing deterministic timer order', async () => {
    const clock = new VirtualPersonaRuntimeClock(0);
    const order: number[] = [];
    clock.setTimer(() => order.push(1), 5);
    clock.setTimer(() => order.push(2), 5);
    await clock.absorbRealTime(5);
    expect(order).toEqual([1, 2]);
  });

  it('fails closed across a hard process crash after a published claim', async () => {
    await expect(exerciseHardCrashProcessBoundary(459)).resolves.toMatchObject({
      replayedClaim: false,
      terminalStatus: 'error',
      mailboxStatus: 'rejected',
      leaseStatus: 'expired',
      failClosed: true,
    });
  });
});
