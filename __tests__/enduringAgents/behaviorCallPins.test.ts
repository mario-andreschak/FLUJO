import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import { archiveModelDispatch, readModelTurnSnapshot, updateModelDispatchOutcome } from '@/backend/execution/flow/modelTurnArchive';
import { FEATURES } from '@/config/features';
import {
  claimNextPersonaActivity, commitPersonaActivityMutation, commitWithPersonaActivityLease,
  completePersonaActivity, enqueuePersonaMailboxItem,
} from '@/backend/services/enduringAgents/activityRuntime';
import {
  BEHAVIOR_CALL_PINS_COLLECTION, BehaviorCallPinSchema, compactBehaviorCallPin,
  completeBehaviorCallPin, createBehaviorCallPin, getBehaviorCallPin, listBehaviorCallPins,
  saveCompactedBehaviorCallPin,
} from '@/backend/services/enduringAgents/behaviorCallPins';
import { getBehaviorCallPinRetentionPolicy } from '@/backend/services/enduringAgents/compactRuntime';
import { deletePersona, previewPersonaDeletion } from '@/backend/services/enduringAgents/personaDeletion';
import { runPersonaRuntimeRetentionSweep } from '@/backend/services/enduringAgents/personaRuntimeRetentionRollout';
import { applyRetention, planRetention } from '@/backend/services/enduringAgents/retention';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { getPersonaStorageStats } from '@/backend/services/enduringAgents/runtimeStorageStats';
import { listBehaviorRevisions, listPersonaActivities } from '@/backend/services/enduringAgents/store';
import { saveCollectionItem } from '@/utils/storage/backend';
import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

jest.setTimeout(60_000);
let sequence = 0;
const fresh = <T>(task: () => Promise<T>) => runWithWorkspace(
  `behavior-pins-${process.pid}-${++sequence}`, task,
);

async function setup() {
  const { persona } = await createPersonaFromRole({ name: 'Private specialist', idempotencyKey: 'owner' });
  const revision = (await listBehaviorRevisions(persona.id)).find((item) => item.slotKey === 'primary')!;
  await enqueuePersonaMailboxItem({
    personaId: persona.id, idempotencyKey: 'call', kind: 'assignment',
    source: { kind: 'assignment', sourceId: 'call' }, summary: 'Call a specialist.',
  });
  const claim = (await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 120_000 }))!;
  const fence = {
    workspaceId: claim.lease.workspaceId, personaId: persona.id, activityId: claim.activity.id,
    leaseId: claim.lease.id, holderId: claim.lease.holderId, fencingToken: claim.lease.fencingToken,
  };
  const authority: FlowExecutionAuthority = {
    signal: new AbortController().signal,
    assertCurrent: () => commitWithPersonaActivityLease(fence, async () => undefined),
    commitWhileCurrent: (task) => commitWithPersonaActivityLease(fence, task),
    commitPersonaMutation: (task) => commitPersonaActivityMutation(fence, task),
  };
  const input = {
    personaId: persona.id, activityId: claim.activity.id,
    parentBehaviorRevisionId: revision.id, revision, callKey: 'first',
  };
  const pin = await createBehaviorCallPin(input, authority);
  return { persona, revision, claim, fence, authority, input, pin };
}

describe('specialist call persistence and privacy', () => {
  it('fences private SDK archives against missing authority and deletion, including queued writes', async () => fresh(async () => {
    const { persona, authority, claim } = await setup();
    const personaAttribution = { personaId: persona.id, activityId: claim.activity.id };
    const input = {
      conversationId: 'conversation_private_archive', nodeId: 'process_private', modelId: 'model_private',
      modelName: 'Private model', adapter: 'openai', operation: 'create', attempt: 1,
      canonicalMessages: [], genericWire: [], sdkRequest: { system: 'Private Core Memory' },
    };
    await expect(archiveModelDispatch({ ...input, durableContext: { personaAttribution } }))
      .rejects.toMatchObject({ code: 'flow_execution_authority_lost' });
    const durableContext = { personaAttribution, executionAuthority: authority };
    const entry = await archiveModelDispatch({ ...input, durableContext });
    const preview = await previewPersonaDeletion(persona.id);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const blocker = withPersonaRuntimeLock(persona.id, async () => { entered(); await hold; });
    await ready;
    const deletion = deletePersona(persona.id, {
      previewToken: preview.previewToken, confirmation: 'DELETE', archivePolicy: 'anonymize',
    });
    const outcome = updateModelDispatchOutcome(input.conversationId, entry.id, 'completed', durableContext);
    const lateArchive = archiveModelDispatch({ ...input, durableContext });
    const settled = Promise.allSettled([deletion, outcome, lateArchive]);
    release();
    await blocker;
    expect((await settled).map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    // This isolated SDK fixture has no conversation index. Its unchanged result
    // proves the rejected writer did not reach disk; the conversation deletion
    // integration separately verifies removal of indexed archives and media.
    expect((await readModelTurnSnapshot(input.conversationId, entry.id))?.entry.outcome).toBe('running');
  }));

  it('requires Activity authority and preserves the first immutable result across retries', async () => fresh(async () => {
    const { input, pin, authority } = await setup();
    await expect(createBehaviorCallPin(input, {} as FlowExecutionAuthority)).rejects.toThrow('authority');
    await expect(createBehaviorCallPin({ ...input, activityId: 'activity_foreign' }, authority))
      .rejects.toThrow('current Activity');
    expect(await createBehaviorCallPin(input, authority)).toEqual(pin);
    const completed = await completeBehaviorCallPin(pin, 'completed', authority, undefined, 'private output');
    expect(await completeBehaviorCallPin(pin, 'error', authority, 'late error')).toEqual(completed);
    await expect(completeBehaviorCallPin({ ...pin, contentHash: 'a'.repeat(64) }, 'completed', authority))
      .rejects.toThrow('immutable identity');
  }));

  it('counts call detail in deletion preview and storage, then erases it before a queued completion can commit', async () => fresh(async () => {
    const { persona, pin, authority, input } = await setup();
    const preview = await previewPersonaDeletion(persona.id);
    expect(preview.counts.behaviorCallPins).toBe(1);
    const stats = await getPersonaStorageStats(persona.id);
    expect(stats.kinds.behaviorCallPins).toMatchObject({ total: 1, uncompacted: 1, byStatus: { running: 1 } });
    expect(stats.kinds.behaviorCallPins.approxBytes).toBeGreaterThan(100);

    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const blocker = withPersonaRuntimeLock(persona.id, async () => { entered(); await hold; });
    await ready;
    const deletion = deletePersona(persona.id, {
      previewToken: preview.previewToken, confirmation: 'DELETE', archivePolicy: 'anonymize',
    });
    const completion = completeBehaviorCallPin(pin, 'completed', authority, undefined, 'must not reappear');
    const settled = Promise.allSettled([deletion, completion]);
    release();
    await blocker;
    expect((await settled).map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(await getBehaviorCallPin(pin.id)).toBeNull();
    await expect(createBehaviorCallPin({ ...input, callKey: 'late' }, authority)).rejects.toThrow();
    expect(await listBehaviorCallPins(persona.id)).toEqual([]);
  }));

  it('changes the privacy confirmation token when a call result changes', async () => fresh(async () => {
    const { persona, pin, authority } = await setup();
    const before = await previewPersonaDeletion(persona.id);
    await completeBehaviorCallPin(pin, 'completed', authority, undefined, 'result');
    const after = await previewPersonaDeletion(persona.id);
    expect(after.previewToken).not.toBe(before.previewToken);
    await expect(deletePersona(persona.id, {
      previewToken: before.previewToken, confirmation: 'DELETE', archivePolicy: 'anonymize',
    })).rejects.toThrow('changed');
    expect(await getBehaviorCallPin(pin.id)).not.toBeNull();
  }));

  it('retains child results while their parent can resume, and compacts payloads after it finishes', async () => fresh(async () => {
    const { persona, pin, authority, fence } = await setup();
    const completed = await completeBehaviorCallPin(pin, 'completed', authority, undefined, 'private output');
    const later = Date.now() + 31 * 24 * 60 * 60 * 1_000;
    await withPersonaRuntimeLock(persona.id, async (lock) => {
      const policy = getBehaviorCallPinRetentionPolicy(await listPersonaActivities(persona.id), lock);
      expect(planRetention([completed], policy, later).candidateCount).toBe(0);
      await expect(saveCompactedBehaviorCallPin(compactBehaviorCallPin(completed, later), lock))
        .rejects.toThrow('still required');
    });
    await completePersonaActivity({ ...fence, status: 'completed' });
    await withPersonaRuntimeLock(persona.id, async (lock) => {
      const policy = getBehaviorCallPinRetentionPolicy(await listPersonaActivities(persona.id), lock);
      expect(await applyRetention([completed], policy, later)).toEqual({ compacted: 1, remaining: 0 });
      await expect(saveCompactedBehaviorCallPin({ ...compactBehaviorCallPin(completed, later), status: 'error' }, lock))
        .rejects.toThrow('immutable receipt');
    });
    const archived = await getBehaviorCallPin(pin.id);
    expect(archived).toMatchObject({ id: pin.id, status: 'completed', contentHash: pin.contentHash, compactedAt: later });
    expect(archived?.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(archived?.flowSnapshot).toBeUndefined();
    expect(archived?.outputText).toBeUndefined();
    expect(BehaviorCallPinSchema.safeParse({ ...archived, outputText: 'leak' }).success).toBe(false);
    expect((await getPersonaStorageStats(persona.id)).kinds.behaviorCallPins.compacted).toBe(1);
    await expect(completeBehaviorCallPin(pin, 'completed', authority)).rejects.toThrow();
  }));

  it('preserves a receipt for a crashed child without rerunning it after its parent terminates', async () => fresh(async () => {
    const { persona, pin, fence } = await setup();
    await completePersonaActivity({ ...fence, status: 'error', error: 'Interrupted child' });
    await withPersonaRuntimeLock(persona.id, async (lock) => {
      const policy = getBehaviorCallPinRetentionPolicy(await listPersonaActivities(persona.id), lock);
      const records = Array.from({ length: 305 }, (_, index) => ({ ...pin, id: `pin_${index}` }));
      const plan = planRetention(records, policy, pin.updatedAt);
      expect(plan.candidateCount).toBe(105);
      expect(plan.candidates).toHaveLength(100);
      const compacted = compactBehaviorCallPin(pin, pin.updatedAt);
      await saveCompactedBehaviorCallPin(compacted, lock);
      expect(await getBehaviorCallPin(pin.id)).toEqual(compacted);
      expect(compacted.status).toBe('running');
    });
  }));

  it('rejects foreign workspace records and leaves a matching id in another workspace untouched', async () => fresh(async () => {
    const { persona, pin } = await setup();
    const source = getCurrentWorkspace();
    const other = `${source}-other`;
    await runWithWorkspace(other, async () => {
      await saveCollectionItem(BEHAVIOR_CALL_PINS_COLLECTION, pin.id, pin);
      await expect(listBehaviorCallPins(persona.id)).rejects.toThrow('storage identity');
      await saveCollectionItem(BEHAVIOR_CALL_PINS_COLLECTION, pin.id, { ...pin, workspaceId: other });
    });
    const preview = await previewPersonaDeletion(persona.id);
    await deletePersona(persona.id, {
      previewToken: preview.previewToken, confirmation: 'DELETE', archivePolicy: 'anonymize',
    });
    expect(await getBehaviorCallPin(pin.id)).toBeNull();
    await runWithWorkspace(other, async () => {
      expect(await getBehaviorCallPin(pin.id)).toMatchObject({ id: pin.id, workspaceId: other });
    });
  }));

  it('includes specialist calls in shadow and active sweeps, with the deployment disable respected', async () => fresh(async () => {
    const { pin, fence } = await setup();
    await completePersonaActivity({ ...fence, status: 'completed' });
    const now = Date.now() + 31 * 24 * 60 * 60 * 1_000;
    const prior = FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION;
    const config = { mode: 'active' as const, rolloutBasisPoints: 10_000, cohortVersion: 'test', criticalPersonaIds: [] };
    try {
      FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION = false;
      expect((await runPersonaRuntimeRetentionSweep({ now, config })).personasExamined).toBe(0);
      FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION = true;
      const shadow = await runPersonaRuntimeRetentionSweep({ now, config: { ...config, mode: 'shadow' } });
      expect(shadow.personasFailed).toBe(0);
      expect(shadow.collections.behaviorCallPins).toMatchObject({ selected: 1, compacted: 0 });
      expect((await getBehaviorCallPin(pin.id))?.flowSnapshot).toBeDefined();
      const active = await runPersonaRuntimeRetentionSweep({ now, config });
      expect(active.personasFailed).toBe(0);
      expect(active.collections.behaviorCallPins).toMatchObject({ selected: 1, compacted: 1 });
      expect((await getBehaviorCallPin(pin.id))?.flowSnapshot).toBeUndefined();
    } finally {
      FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION = prior;
    }
  }));
});
