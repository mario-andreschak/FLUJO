import {
  PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
  PERSONA_RUNTIME_RETENTION_POLICY,
  getActivityRetentionPolicy,
  getFlowDispatchRetentionPolicy,
  getMailboxItemRetentionPolicy,
} from '@/backend/services/enduringAgents/compactRuntime';
import {
  PERSONA_ACTIVITY_SCHEMA_VERSION,
  PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION,
  PersonaActivitySchema,
  type PersonaMailboxItem,
} from '@/shared/types/enduringAgent';
import {
  PERSONA_FLOW_DISPATCH_SCHEMA_VERSION,
  PersonaFlowDispatchRecordSchema,
  type PersonaFlowDispatchRecord,
} from '@/backend/services/enduringAgents/personaDispatcher';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import { listPersonaFlowDispatchRecordsForRetention } from '@/backend/services/enduringAgents/personaFlowDispatchRetention';
import {
  acquirePersonaRuntimeRetentionWriteGrant,
  type PersonaRuntimeRetentionWriteGrant,
} from '@/backend/services/enduringAgents/personaRuntimeRetentionControl';
import {
  executeRetentionPlan,
  planRetention,
  type RetentionPolicy,
} from '@/backend/services/enduringAgents/retention';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import {
  listCollectionItemsWithStats,
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

import { storeRetentionState } from './fixtures/retentionState';

interface RetentionProbe {
  id: string;
  timestamp: number;
  payload?: string;
  compactedAt?: number;
}

function probePolicy(retentionMs: number, detailedLimit: number): RetentionPolicy<RetentionProbe> {
  return {
    recordKind: 'RetentionProbe',
    isEligible: (record) => record.compactedAt === undefined,
    timestampOf: (record) => record.timestamp,
    isCompacted: (record) => record.compactedAt !== undefined,
    retentionMs,
    detailedLimit,
    compact: (record, compactedAt) => ({ ...record, payload: undefined, compactedAt }),
    isValidCompaction: (record, compacted) => record.id === compacted.id,
    save: async () => undefined,
  };
}

const probe = (id: string, timestamp: number): RetentionProbe => ({ id, timestamp, payload: 'x'.repeat(64) });

function completedDispatch(): PersonaFlowDispatchRecord {
  return {
    schemaVersion: PERSONA_FLOW_DISPATCH_SCHEMA_VERSION,
    id: 'dispatch_1',
    workspaceId: 'workspace_1',
    personaId: 'persona_1',
    idempotencyDigest: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    state: 'completed',
    admission: {
      kind: 'assignment',
      priority: 'normal',
      source: { kind: 'assignment', sourceId: 'source_1' },
    },
    flowInput: {
      source: 'api',
      prompt: 'private prompt',
      variables: { privateValue: 'secret' },
    },
    mailboxItemId: 'mailbox_1',
    activityId: 'activity_1',
    behaviorRevisionId: 'revision_1',
    targetActivityId: 'activity_1',
    waitingReason: undefined,
    createdAt: 100,
    updatedAt: 200,
    startedAt: 150,
    completedAt: 200,
    terminalProjectionsSettledAt: 200,
  };
}

function erroredActivityWithCoreSnapshot() {
  return PersonaActivitySchema.parse({
    schemaVersion: PERSONA_ACTIVITY_SCHEMA_VERSION,
    id: 'activity_1',
    personaId: 'persona_1',
    kind: 'assignment',
    status: 'error',
    source: { kind: 'assignment', sourceId: 'source_1' },
    behaviorId: 'behavior_1',
    behaviorRevisionId: 'revision_1',
    coreFlowId: 'flow_1',
    coreFlowRevisionId: 'revision_1',
    coreAppRefs: ['test-app'],
    instructionContext: {
      schemaVersion: PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION,
      personaId: 'persona_1',
      activityId: 'activity_1',
      behaviorRevisionId: 'revision_1',
      behaviorContentHash: 'c'.repeat(64),
      behaviorSlotKey: 'primary',
      rootFlowId: 'flow_1',
      roleVersionId: 'role_version_1',
      personaName: 'Compaction Persona',
      roleName: 'Compaction Role',
      roleMission: 'Exercise schema-valid runtime retention.',
      instruction: 'Private frozen instructions.',
    },
    instructionContextDigest: 'd'.repeat(64),
    instructionContextSchemaVersion: PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION,
    entryPointPayloadRef: 'private-entry-point',
    resourceRefs: ['private-resource'],
    outcomeRef: 'private-outcome',
    error: 'private failure details',
    createdAt: 100,
    updatedAt: 200,
    startedAt: 150,
    completedAt: 200,
  });
}

describe('Persona runtime compaction', () => {
  it('applies the approved per-kind retention windows and detailed rank caps', () => {
    const dayMs = 24 * 60 * 60 * 1000;

    expect(PERSONA_RUNTIME_RETENTION_POLICY).toEqual({
      mailboxItem: { retentionMs: 30 * dayMs, detailedLimit: 500 },
      activity: { retentionMs: 30 * dayMs, detailedLimit: 200 },
      flowDispatch: { retentionMs: 30 * dayMs, detailedLimit: 200 },
      behaviorCallPin: { retentionMs: 30 * dayMs, detailedLimit: 200 },
    });
    expect(getMailboxItemRetentionPolicy()).toMatchObject(
      PERSONA_RUNTIME_RETENTION_POLICY.mailboxItem,
    );
    expect(getActivityRetentionPolicy()).toMatchObject(
      PERSONA_RUNTIME_RETENTION_POLICY.activity,
    );
    expect(getFlowDispatchRetentionPolicy()).toMatchObject(
      PERSONA_RUNTIME_RETENTION_POLICY.flowDispatch,
    );
  });

  it('uses a strict age cutoff', () => {
    const now = 10_000_000_000;
    const { retentionMs } = PERSONA_RUNTIME_RETENTION_POLICY.mailboxItem;
    const cutoff = now - retentionMs;

    const plan = planRetention(
      [probe('exact_cutoff', cutoff), probe('one_ms_older', cutoff - 1)],
      probePolicy(retentionMs, 2),
      now,
    );

    expect(plan.candidates.map((candidate) => candidate.projected)).toEqual([
      { id: 'one_ms_older', timestamp: cutoff - 1, payload: undefined, compactedAt: now },
    ]);
  });

  it.each(Object.entries(PERSONA_RUNTIME_RETENTION_POLICY))(
    'keeps exactly the configured newest-N detail for %s',
    (_kind, configuration) => {
      const timestamp = 10_000;
      const records = Array.from(
        { length: configuration.detailedLimit + 1 },
        (_, index) => probe(`record_${String(index).padStart(4, '0')}`, timestamp),
      );

      const plan = planRetention(
        records,
        probePolicy(configuration.retentionMs, configuration.detailedLimit),
        timestamp,
      );

      expect(plan.candidateCount).toBe(1);
      expect(plan.candidates[0].record.id).toBe('record_0000');
    },
  );

  it('waits until a coalesced input is delivered and a dispatch is settled', () => {
    const later = 1 + PERSONA_RUNTIME_RETENTION_POLICY.mailboxItem.retentionMs + 1;
    const pending = {
      id: 'mailbox_pending',
      status: 'coalesced',
      deliveryStatus: 'pending',
      updatedAt: 1,
    } as PersonaMailboxItem;
    expect(planRetention([pending], getMailboxItemRetentionPolicy(), later).eligible).toBe(0);
    expect(planRetention([{ ...pending, deliveryStatus: 'delivered' }], getMailboxItemRetentionPolicy(), later)
      .eligible).toBe(1);

    const unsettled = { ...completedDispatch(), terminalProjectionsSettledAt: undefined };
    expect(planRetention([unsettled], getFlowDispatchRetentionPolicy(), later).eligible).toBe(0);
    expect(planRetention([completedDispatch()], getFlowDispatchRetentionPolicy(), later).eligible).toBe(1);
  });

  it('treats a compaction that changes identity as invalid', () => {
    const original = completedDispatch();
    const policy = getFlowDispatchRetentionPolicy();
    expect(policy.isValidCompaction(original, policy.compact(original, 300))).toBe(true);
    expect(policy.isValidCompaction(original, { ...policy.compact(original, 300), activityId: 'activity_2' }))
      .toBe(false);
    expect(policy.isValidCompaction(original, { ...policy.compact(original, 300), state: 'queued' })).toBe(false);
  });

  it('produces a schema-valid compacted Flow dispatch while preserving audit identity', () => {
    const original = completedDispatch();
    const policy = getFlowDispatchRetentionPolicy();
    const compacted = policy.compact(original, 300);

    expect(() => PersonaFlowDispatchRecordSchema.parse(compacted)).not.toThrow();
    expect(compacted).toEqual(expect.objectContaining({
      id: original.id,
      workspaceId: original.workspaceId,
      personaId: original.personaId,
      idempotencyDigest: original.idempotencyDigest,
      requestHash: original.requestHash,
      state: original.state,
      activityId: original.activityId,
      behaviorRevisionId: original.behaviorRevisionId,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
      completedAt: original.completedAt,
      terminalProjectionsSettledAt: original.terminalProjectionsSettledAt,
      compactedAt: 300,
    }));
    expect(compacted.flowInput).toBeUndefined();
    expect(compacted.instructionContext).toBeUndefined();
    expect(compacted.maintenancePlan).toBeUndefined();
    expect(compacted.maintenanceResult).toBeUndefined();
    expect(compacted.routingDecision).toBeUndefined();
  });

  it('produces a schema-valid compacted errored Activity while preserving Core identity', () => {
    const original = erroredActivityWithCoreSnapshot();
    const compacted = getActivityRetentionPolicy().compact(original, 300);

    expect(() => PersonaActivitySchema.parse(compacted)).not.toThrow();
    expect(compacted).toEqual(expect.objectContaining({
      id: original.id,
      personaId: original.personaId,
      status: original.status,
      behaviorRevisionId: original.behaviorRevisionId,
      coreFlowId: original.coreFlowId,
      coreFlowRevisionId: original.coreFlowRevisionId,
      instructionContextDigest: original.instructionContextDigest,
      instructionContextSchemaVersion: original.instructionContextSchemaVersion,
      compactedAt: 300,
    }));
    expect(compacted.instructionContext).toBeUndefined();
    expect(compacted.entryPointPayloadRef).toBeUndefined();
    expect(compacted.resourceRefs).toBeUndefined();
    expect(compacted.error).toBeUndefined();
    expect(compacted.outcomeRef).toBeUndefined();
  });

  it('persists schema-valid Flow-dispatch compaction through the real adapter', async () => {
    const workspaceId = `compact-runtime-${process.pid}`;
    const original = completedDispatch();
    const now = original.completedAt! + getFlowDispatchRetentionPolicy().retentionMs + 1;

    const { result, stored, metadata } = await runWithWorkspace(workspaceId, async () => {
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.flowDispatches,
        original.id,
        { ...original, workspaceId },
      );
      await storeRetentionState({ mode: 'active' });
      const result = await withPersonaRuntimeLock(original.personaId, async (lock) => {
        const grant = await acquirePersonaRuntimeRetentionWriteGrant(original.personaId, lock);
        if (!grant) throw new Error('Active retention must issue a write grant.');
        const policy = getFlowDispatchRetentionPolicy();
        const plan = planRetention(
          await listPersonaFlowDispatchRecordsForRetention(original.personaId),
          policy,
          now,
        );
        return executeRetentionPlan(plan, policy, { grant });
      });
      const stored = await loadCollectionItem<unknown | null>(
        ENDURING_AGENT_COLLECTIONS.flowDispatches,
        original.id,
        null,
      );
      const metadata = await listCollectionItemsWithStats<unknown>(
        ENDURING_AGENT_COLLECTIONS.flowDispatches,
      );
      return { result, stored, metadata };
    });

    expect(result.compacted).toBe(1);
    expect(result.remaining).toBe(0);
    expect(metadata).toEqual([
      expect.objectContaining({
        id: original.id,
        mtimeMs: expect.any(Number),
        sizeBytes: expect.any(Number),
      }),
    ]);
    const parsed = PersonaFlowDispatchRecordSchema.parse(stored);
    expect(parsed.compactedAt).toBe(now);
    expect(parsed.flowInput).toBeUndefined();
  });

  it('writes only with a grant issued while cleanup is on', async () => {
    const workspaceId = `compact-runtime-grant-${process.pid}`;
    const original = completedDispatch();
    const now = original.completedAt! + getFlowDispatchRetentionPolicy().retentionMs + 1;

    const outcome = await runWithWorkspace(workspaceId, async () => {
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.flowDispatches,
        original.id,
        { ...original, workspaceId },
      );
      await storeRetentionState({ mode: 'shadow' });
      return withPersonaRuntimeLock(original.personaId, async (lock) => {
        const shadowGrant = await acquirePersonaRuntimeRetentionWriteGrant(original.personaId, lock);
        const forged: PersonaRuntimeRetentionWriteGrant = {
          personaId: original.personaId,
          authorize: async () => true,
        };
        const policy = getFlowDispatchRetentionPolicy();
        const plan = planRetention(
          await listPersonaFlowDispatchRecordsForRetention(original.personaId),
          policy,
          now,
        );
        const forgedError = await executeRetentionPlan(plan, policy, { grant: forged }).then(
          () => null,
          (error: unknown) => error,
        );
        const stored = await loadCollectionItem<PersonaFlowDispatchRecord | null>(
          ENDURING_AGENT_COLLECTIONS.flowDispatches,
          original.id,
          null,
        );
        return { shadowGrant, forgedError, stored };
      });
    });

    expect(outcome.shadowGrant).toBeNull();
    expect(String(outcome.forgedError)).toContain('acquirePersonaRuntimeRetentionWriteGrant');
    expect(outcome.stored?.compactedAt).toBeUndefined();
    expect(outcome.stored?.flowInput).toEqual(original.flowInput);
  });

  it('rejects compacted non-terminal envelopes', () => {
    expect(() => PersonaFlowDispatchRecordSchema.parse({
      ...completedDispatch(),
      state: 'queued',
      completedAt: undefined,
      compactedAt: 300,
    })).toThrow();
  });

  it('caps writes for every cleanup sweep', () => {
    const policies = [
      getMailboxItemRetentionPolicy(),
      getActivityRetentionPolicy(),
      getFlowDispatchRetentionPolicy(),
    ];
    for (const policy of policies) {
      expect(policy.maxWritesPerSweep)
        .toBe(PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP);
    }
  });
});
