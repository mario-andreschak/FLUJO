import {
  PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
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
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import {
  listCollectionItemsWithStats,
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

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

  it('caps writes for every completion-triggered sweep', () => {
    const policies = [
      getMailboxItemRetentionPolicy(),
      getActivityRetentionPolicy(),
      getFlowDispatchRetentionPolicy(),
      getLeaseHistoryRetentionPolicy(),
    ];
    for (const policy of policies) {
      expect(policy.maxWritesPerSweep)
        .toBe(PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP);
    }
  });
});
