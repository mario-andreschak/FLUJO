import {
  PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
  PERSONA_RUNTIME_RETENTION_POLICY,
  compactPersonaFlowDispatches,
  getActivityRetentionPolicy,
  getFlowDispatchRetentionPolicy,
  getLeaseHistoryRetentionPolicy,
  getMailboxItemRetentionPolicy,
} from '@/backend/services/enduringAgents/compactRuntime';
import {
  PERSONA_FLOW_DISPATCH_SCHEMA_VERSION,
  PersonaFlowDispatchRecordSchema,
  type PersonaFlowDispatchRecord,
} from '@/backend/services/enduringAgents/personaDispatcher';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  applyRetention,
  type RetentionPolicy,
} from '@/backend/services/enduringAgents/retention';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import {
  listCollectionItemsWithStats,
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

interface RetentionProbe {
  id: string;
  timestamp: number;
  compactedAt?: number;
}

function probePolicy(
  retentionMs: number,
  detailedLimit: number,
  save: (record: RetentionProbe) => Promise<unknown>,
): RetentionPolicy<RetentionProbe> {
  return {
    recordKind: 'RetentionProbe',
    isEligible: (record) => record.compactedAt === undefined,
    timestampOf: (record) => record.timestamp,
    isCompacted: (record) => record.compactedAt !== undefined,
    retentionMs,
    detailedLimit,
    compact: (record, compactedAt) => ({ ...record, compactedAt }),
    save,
  };
}

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
  };
}

describe('Persona runtime compaction', () => {
  it('applies the approved per-kind retention windows and detailed rank caps', () => {
    const dayMs = 24 * 60 * 60 * 1000;

    expect(PERSONA_RUNTIME_RETENTION_POLICY).toEqual({
      mailboxItem: { retentionMs: 30 * dayMs, detailedLimit: 500 },
      activity: { retentionMs: 30 * dayMs, detailedLimit: 200 },
      flowDispatch: { retentionMs: 30 * dayMs, detailedLimit: 200 },
      leaseHistory: { retentionMs: 90 * dayMs, detailedLimit: 1_000 },
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
    expect(getLeaseHistoryRetentionPolicy()).toMatchObject(
      PERSONA_RUNTIME_RETENTION_POLICY.leaseHistory,
    );
  });

  it.each([
    ['30-day runtime records', PERSONA_RUNTIME_RETENTION_POLICY.mailboxItem.retentionMs],
    ['90-day lease history', PERSONA_RUNTIME_RETENTION_POLICY.leaseHistory.retentionMs],
  ])('uses a strict age cutoff for %s', async (_label, retentionMs) => {
    const now = 10_000_000_000;
    const cutoff = now - retentionMs;
    const save = jest.fn(async () => undefined);
    const records: RetentionProbe[] = [
      { id: 'exact_cutoff', timestamp: cutoff },
      { id: 'one_ms_older', timestamp: cutoff - 1 },
    ];

    const result = await applyRetention(
      records,
      probePolicy(retentionMs, records.length, save),
      now,
    );

    expect(result).toEqual({ compacted: 1, remaining: 1 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      id: 'one_ms_older',
      timestamp: cutoff - 1,
      compactedAt: now,
    });
  });

  it.each(Object.entries(PERSONA_RUNTIME_RETENTION_POLICY))(
    'keeps exactly the configured newest-N detail for %s',
    async (_kind, configuration) => {
      const timestamp = 10_000;
      const save = jest.fn(async () => undefined);
      const records = Array.from(
        { length: configuration.detailedLimit + 1 },
        (_, index): RetentionProbe => ({
          id: `record_${String(index).padStart(4, '0')}`,
          timestamp,
        }),
      );

      const result = await applyRetention(
        records,
        probePolicy(configuration.retentionMs, configuration.detailedLimit, save),
        timestamp,
      );

      expect(result).toEqual({ compacted: 1, remaining: configuration.detailedLimit });
      expect(save).toHaveBeenCalledWith({
        id: 'record_0000',
        timestamp,
        compactedAt: timestamp,
      });
    },
  );

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
      compactedAt: 300,
    }));
    expect(compacted.flowInput).toBeUndefined();
    expect(compacted.instructionContext).toBeUndefined();
    expect(compacted.maintenancePlan).toBeUndefined();
    expect(compacted.maintenanceResult).toBeUndefined();
    expect(compacted.routingDecision).toBeUndefined();
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
      const result = await withPersonaRuntimeLock(original.personaId, () => (
        compactPersonaFlowDispatches(original.personaId, now)
      ));
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

  it('rejects compacted non-terminal envelopes', () => {
    expect(() => PersonaFlowDispatchRecordSchema.parse({
      ...completedDispatch(),
      state: 'queued',
      completedAt: undefined,
      compactedAt: 300,
    })).toThrow();
  });

  it('caps writes for every completion-triggered soft-retention sweep', () => {
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
