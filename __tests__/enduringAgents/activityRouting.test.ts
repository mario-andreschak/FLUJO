import {
  PersonaBusyError,
  PersonaLeaseLostError,
  PersonaMailboxConflictError,
  PersonaRuntimeUnavailableError,
  acknowledgePersonaActivityDelivery,
  claimNextPersonaActivity,
  completePersonaActivity,
  createPersonaFromRole,
  enqueuePersonaMailboxItem,
  listPendingPersonaActivityDeliveries,
  rejectPersonaActivityDelivery,
  releasePersonaActivityLease,
  routePersonaMailboxItem,
  updatePersonaActivityReferences,
  yieldPersonaActivityForInterruption,
  type PersonaActivityClaim,
  type PersonaLeaseFence,
} from '@/backend/services/enduringAgents';
import {
  getPersonaActivity,
  getPersonaLease,
  getPersonaMailboxItem,
} from '@/backend/services/enduringAgents/store';
import type {
  CreatePersonaMailboxItemInput,
  PersonaInterruptionPolicy,
} from '@/shared/types/enduringAgent';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(
    `enduring-routing-${process.pid}-${workspaceSequence}`,
    task,
  );
}

async function createPersona(
  interruptionPolicy: PersonaInterruptionPolicy,
  idempotencyKey: string,
) {
  return createPersonaFromRole({
    name: `Routing ${idempotencyKey}`,
    idempotencyKey,
    interruptionPolicy,
  });
}

function assignment(
  personaId: string,
  idempotencyKey: string,
  overrides: Partial<CreatePersonaMailboxItemInput> = {},
): CreatePersonaMailboxItemInput {
  return {
    personaId,
    idempotencyKey,
    kind: 'assignment',
    source: { kind: 'assignment', sourceId: `source-${idempotencyKey}` },
    summary: `Assignment ${idempotencyKey}`,
    ...overrides,
  };
}

async function claim(personaId: string): Promise<PersonaActivityClaim> {
  const claimed = await claimNextPersonaActivity({ personaId, ttlMs: 10_000 });
  expect(claimed).not.toBeNull();
  return claimed!;
}

function fence(claimed: PersonaActivityClaim): PersonaLeaseFence {
  return {
    workspaceId: claimed.lease.workspaceId,
    personaId: claimed.lease.personaId,
    activityId: claimed.lease.activityId,
    leaseId: claimed.lease.id,
    holderId: claimed.lease.holderId,
    fencingToken: claimed.lease.fencingToken,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('enduring-agent Activity routing', () => {
  it('keeps queue policy and the legacy enqueue API queue-only', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersona('queue', 'queue-policy');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'active', {
        relationKey: 'ticket-415',
      }));
      const active = await claim(persona.id);

      const routed = await routePersonaMailboxItem(assignment(persona.id, 'related', {
        relationKey: 'ticket-415',
        relatedAction: 'steer',
      }));
      expect(routed).toMatchObject({ decision: 'queued' });
      expect(routed.item).toMatchObject({ status: 'queued', routingDecision: 'queue' });
      expect(routed.item).not.toHaveProperty('targetActivityId');
      expect(routed.item).not.toHaveProperty('deliveryStatus');

      const legacy = await enqueuePersonaMailboxItem(assignment(persona.id, 'legacy-related', {
        relationKey: 'ticket-415',
        relatedAction: 'coalesce',
      }));
      expect(legacy).toMatchObject({ duplicate: false, item: { status: 'queued' } });
      expect(legacy.item).not.toHaveProperty('routingDecision');

      await expect(routePersonaMailboxItem(assignment(persona.id, 'missing-relation', {
        relatedAction: 'steer',
      }))).rejects.toThrow(/relationKey/i);
      expect(await getPersonaLease(persona.id)).toMatchObject({
        id: active.lease.id,
        status: 'active',
      });
    });
  });

  it('atomically steers matching related work and durably acknowledges it once', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersona('related_only', 'related-policy');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'active', {
        relationKey: 'conversation-1',
      }));
      const active = await claim(persona.id);
      const firstInput = assignment(persona.id, 'steer-1', {
        relationKey: 'conversation-1',
        relatedAction: 'steer',
      });
      const secondInput = assignment(persona.id, 'coalesce-2', {
        relationKey: 'conversation-1',
        relatedAction: 'coalesce',
      });

      const first = await routePersonaMailboxItem(firstInput);
      const second = await routePersonaMailboxItem(secondInput);
      expect(first).toMatchObject({
        decision: 'steered',
        targetActivityId: active.activity.id,
        item: {
          status: 'coalesced',
          routingDecision: 'steer',
          deliveryStatus: 'pending',
          targetActivityId: active.activity.id,
          coalescedIntoId: active.mailboxItem.id,
        },
      });
      expect(second).toMatchObject({
        decision: 'coalesced',
        targetActivityId: active.activity.id,
      });
      expect(first.item.id).not.toBe(active.mailboxItem.id);
      expect(first.item).not.toHaveProperty('claimedActivityId');

      await expect(routePersonaMailboxItem(firstInput)).resolves.toEqual({
        item: first.item,
        decision: 'duplicate',
        targetActivityId: active.activity.id,
      });
      await expect(routePersonaMailboxItem({
        ...firstInput,
        relatedAction: 'coalesce',
      })).rejects.toBeInstanceOf(PersonaMailboxConflictError);

      const pending = await listPendingPersonaActivityDeliveries(fence(active));
      expect(pending.map((item) => item.id)).toEqual([first.item.id, second.item.id]);
      const delivered = await acknowledgePersonaActivityDelivery({
        ...fence(active),
        mailboxItemId: first.item.id,
      });
      expect(delivered).toMatchObject({ deliveryStatus: 'delivered' });
      expect(delivered.deliveredAt).toEqual(expect.any(Number));
      await expect(acknowledgePersonaActivityDelivery({
        ...fence(active),
        mailboxItemId: first.item.id,
      })).resolves.toEqual(delivered);
      await expect(listPendingPersonaActivityDeliveries(fence(active)))
        .resolves.toEqual([second.item]);
      const rejected = await rejectPersonaActivityDelivery({
        ...fence(active),
        mailboxItemId: second.item.id,
      });
      expect(rejected).toMatchObject({
        status: 'rejected',
        routingDecision: 'queue',
      });
      expect(rejected.deliveryStatus).toBeUndefined();
      expect(rejected.targetActivityId).toBeUndefined();
      await expect(rejectPersonaActivityDelivery({
        ...fence(active),
        mailboxItemId: second.item.id,
      })).rejects.toBeInstanceOf(PersonaLeaseLostError);
      await expect(listPendingPersonaActivityDeliveries(fence(active))).resolves.toEqual([]);

      const released = await releasePersonaActivityLease(fence(active));
      expect(released.status).toBe('released');
      await expect(acknowledgePersonaActivityDelivery({
        ...fence(active),
        mailboxItemId: second.item.id,
      })).rejects.toBeInstanceOf(PersonaLeaseLostError);
    });
  });

  it('routes matching work to a released waiting Activity but queues mismatches', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersona('related_only', 'waiting-related');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'waiting', {
        relationKey: 'case-1',
      }));
      const waiting = await claim(persona.id);
      await releasePersonaActivityLease(fence(waiting));

      const related = await routePersonaMailboxItem(assignment(persona.id, 'related', {
        relationKey: 'case-1',
        relatedAction: 'coalesce',
      }));
      expect(related).toMatchObject({
        decision: 'coalesced',
        targetActivityId: waiting.activity.id,
        item: { status: 'coalesced', deliveryStatus: 'pending' },
      });
      const mismatch = await routePersonaMailboxItem(assignment(persona.id, 'mismatch', {
        relationKey: 'case-2',
        relatedAction: 'steer',
      }));
      expect(mismatch).toMatchObject({
        decision: 'queued',
        item: { status: 'queued', routingDecision: 'queue' },
      });

      const resumed = await claim(persona.id);
      expect(resumed.activity.id).toBe(waiting.activity.id);
      await expect(listPendingPersonaActivityDeliveries(fence(resumed)))
        .resolves.toEqual([related.item]);
      await completePersonaActivity(fence(resumed));

      // A delivery admitted after the worker's final poll is atomically
      // converted to ordinary queued work at the terminal boundary.
      const next = await claim(persona.id);
      expect(next.mailboxItem.id).toBe(related.item.id);
      expect(next.mailboxItem).toMatchObject({
        status: 'claimed',
        routingDecision: 'queue',
      });
      expect(next.mailboxItem).not.toHaveProperty('targetActivityId');
      expect(next.mailboxItem).not.toHaveProperty('deliveryStatus');
      await completePersonaActivity(fence(next));
      const afterRelated = await claim(persona.id);
      expect(afterRelated.mailboxItem.id).toBe(mismatch.item.id);
    });
  });

  it('requeues an unacknowledged related delivery when its target lease expires', async () => {
    await inFreshWorkspace(async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
      const { persona } = await createPersona('related_only', 'expired-related');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'active', {
        relationKey: 'conversation-expired',
      }));
      const active = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 1_000 });
      expect(active).not.toBeNull();
      const related = await routePersonaMailboxItem(assignment(persona.id, 'late-input', {
        relationKey: 'conversation-expired',
        relatedAction: 'steer',
      }));
      expect(related.item).toMatchObject({
        status: 'coalesced',
        deliveryStatus: 'pending',
        targetActivityId: active!.activity.id,
      });

      nowSpy.mockReturnValue(11_000);
      const recovered = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 1_000 });
      expect(recovered?.mailboxItem.id).toBe(related.item.id);
      expect(recovered?.mailboxItem).toMatchObject({
        status: 'claimed',
        routingDecision: 'queue',
      });
      expect(recovered?.mailboxItem).not.toHaveProperty('targetActivityId');
      expect(recovered?.mailboxItem).not.toHaveProperty('deliveryStatus');
      expect(await getPersonaActivity(active!.activity.id)).toMatchObject({ status: 'error' });
    });
  });

  it('never crosses Persona boundaries when routing or acknowledging related work', async () => {
    await inFreshWorkspace(async () => {
      const firstBundle = await createPersona('related_only', 'relation-first');
      const secondBundle = await createPersona('related_only', 'relation-second');
      await enqueuePersonaMailboxItem(assignment(firstBundle.persona.id, 'first-active', {
        relationKey: 'shared-key',
      }));
      await enqueuePersonaMailboxItem(assignment(secondBundle.persona.id, 'second-active', {
        relationKey: 'shared-key',
      }));
      const first = await claim(firstBundle.persona.id);
      const second = await claim(secondBundle.persona.id);

      const routed = await routePersonaMailboxItem(assignment(
        secondBundle.persona.id,
        'second-related',
        { relationKey: 'shared-key', relatedAction: 'steer' },
      ));
      expect(routed.targetActivityId).toBe(second.activity.id);
      expect(routed.targetActivityId).not.toBe(first.activity.id);
      await expect(acknowledgePersonaActivityDelivery({
        ...fence(first),
        mailboxItemId: routed.item.id,
      })).rejects.toBeInstanceOf(PersonaLeaseLostError);
      await expect(listPendingPersonaActivityDeliveries(fence(second)))
        .resolves.toEqual([routed.item]);
    });
  });

  it('cooperatively interrupts without overlap, runs urgent work, then resumes', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersona('allow_urgent', 'urgent-policy');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'long-running'));
      const original = await claim(persona.id);
      await expect(yieldPersonaActivityForInterruption(fence(original)))
        .rejects.toBeInstanceOf(PersonaRuntimeUnavailableError);

      const unmatchedRelated = await routePersonaMailboxItem(assignment(
        persona.id,
        'urgent-but-related',
        {
          priority: 'urgent',
          relationKey: 'unmatched-relation',
          relatedAction: 'steer',
        },
      ));
      expect(unmatchedRelated).toMatchObject({
        decision: 'queued',
        item: { routingDecision: 'queue' },
      });

      const urgentInput = assignment(persona.id, 'urgent', {
        priority: 'urgent',
      });
      const urgent = await routePersonaMailboxItem(urgentInput);
      expect(urgent).toMatchObject({
        decision: 'interrupt_requested',
        targetActivityId: original.activity.id,
        item: {
          status: 'queued',
          routingDecision: 'interrupt',
          interruptedActivityId: original.activity.id,
        },
      });
      expect(await getPersonaActivity(original.activity.id)).toMatchObject({
        status: 'running',
        leaseId: original.lease.id,
        interruptionRequestedByMailboxItemId: urgent.item.id,
        interruptionRequestedAt: expect.any(Number),
      });
      expect(await getPersonaLease(persona.id)).toMatchObject({
        id: original.lease.id,
        status: 'active',
      });
      await expect(claimNextPersonaActivity({ personaId: persona.id, ttlMs: 10_000 }))
        .rejects.toBeInstanceOf(PersonaBusyError);

      await expect(yieldPersonaActivityForInterruption(fence(original)))
        .resolves.toMatchObject({ id: original.lease.id, status: 'released' });
      const urgentClaim = await claim(persona.id);
      expect(urgentClaim.mailboxItem.id).toBe(urgent.item.id);
      expect(urgentClaim.activity.id).not.toBe(original.activity.id);
      expect(await getPersonaActivity(original.activity.id)).toMatchObject({ status: 'waiting' });
      await completePersonaActivity(fence(urgentClaim));

      const resumed = await claim(persona.id);
      expect(resumed.activity.id).toBe(original.activity.id);
      expect(resumed.lease.fencingToken).toBeGreaterThan(urgentClaim.lease.fencingToken);
      expect(resumed.activity.interruptionRequestedAt).toBeUndefined();
      expect(resumed.activity.interruptionRequestedByMailboxItemId).toBeUndefined();
      await expect(routePersonaMailboxItem(urgentInput)).resolves.toMatchObject({
        decision: 'duplicate',
        item: { id: urgent.item.id, status: 'completed' },
      });
      expect((await getPersonaActivity(original.activity.id))?.interruptionRequestedAt)
        .toBeUndefined();
    });
  });

  it('does not resume an interrupted Activity ahead of deferred targeted urgent work', async () => {
    await inFreshWorkspace(async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100_000);
      const { persona } = await createPersona('allow_urgent', 'deferred-urgent');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'original'));
      const original = await claim(persona.id);
      const urgent = await routePersonaMailboxItem(assignment(persona.id, 'deferred', {
        priority: 'urgent',
        notBefore: 101_000,
      }));
      await yieldPersonaActivityForInterruption(fence(original));

      await expect(claimNextPersonaActivity({ personaId: persona.id, ttlMs: 10_000 }))
        .resolves.toBeNull();
      expect(await getPersonaActivity(original.activity.id)).toMatchObject({ status: 'waiting' });

      nowSpy.mockReturnValue(101_000);
      const urgentClaim = await claim(persona.id);
      expect(urgentClaim.mailboxItem.id).toBe(urgent.item.id);
      await completePersonaActivity(fence(urgentClaim));
      const resumed = await claim(persona.id);
      expect(resumed.activity.id).toBe(original.activity.id);
    });
  });

  it('preserves the resume chain across nested cooperative interruptions', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersona('allow_urgent', 'nested-urgent');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'original'));
      const original = await claim(persona.id);

      const firstUrgent = await routePersonaMailboxItem(assignment(persona.id, 'urgent-1', {
        priority: 'urgent',
      }));
      expect(firstUrgent.targetActivityId).toBe(original.activity.id);
      await yieldPersonaActivityForInterruption(fence(original));
      const firstUrgentClaim = await claim(persona.id);
      expect(firstUrgentClaim.mailboxItem.id).toBe(firstUrgent.item.id);

      const secondUrgent = await routePersonaMailboxItem(assignment(persona.id, 'urgent-2', {
        priority: 'urgent',
      }));
      expect(secondUrgent.targetActivityId).toBe(firstUrgentClaim.activity.id);
      await yieldPersonaActivityForInterruption(fence(firstUrgentClaim));
      const secondUrgentClaim = await claim(persona.id);
      expect(secondUrgentClaim.mailboxItem.id).toBe(secondUrgent.item.id);

      await completePersonaActivity(fence(secondUrgentClaim));
      const resumedFirstUrgent = await claim(persona.id);
      expect(resumedFirstUrgent.activity.id).toBe(firstUrgentClaim.activity.id);
      await completePersonaActivity(fence(resumedFirstUrgent));

      const resumedOriginal = await claim(persona.id);
      expect(resumedOriginal.activity.id).toBe(original.activity.id);
    });
  });

  it('fences trusted Activity reference updates and rejects malformed or foreign input', async () => {
    await inFreshWorkspace(async () => {
      const firstBundle = await createPersona('queue', 'references-first');
      const secondBundle = await createPersona('queue', 'references-second');
      await enqueuePersonaMailboxItem(assignment(firstBundle.persona.id, 'references'));
      const active = await claim(firstBundle.persona.id);

      const updated = await updatePersonaActivityReferences({
        ...fence(active),
        conversationId: 'conversation_415',
        runId: 'run_415',
        meetingId: 'meeting_415',
        resourceRefs: ['resource://one', 'resource://two'],
        outcomeRef: 'outcome://pending',
      });
      expect(updated).toMatchObject({
        id: active.activity.id,
        conversationId: 'conversation_415',
        runId: 'run_415',
        meetingId: 'meeting_415',
        resourceRefs: ['resource://one', 'resource://two'],
        outcomeRef: 'outcome://pending',
      });

      await expect(updatePersonaActivityReferences({
        ...fence(active),
        conversationId: '../foreign',
      })).rejects.toThrow();
      await expect(updatePersonaActivityReferences({
        ...fence(active),
        arbitraryState: 'not trusted',
      })).rejects.toThrow();
      await expect(updatePersonaActivityReferences({
        ...fence(active),
        personaId: secondBundle.persona.id,
        conversationId: 'conversation_foreign',
      })).rejects.toBeInstanceOf(PersonaLeaseLostError);

      const completed = await completePersonaActivity(fence(active));
      expect(completed.activity).toMatchObject({
        status: 'completed',
        outcomeRef: 'outcome://pending',
      });
      await expect(completePersonaActivity(fence(active))).resolves.toMatchObject({
        activity: { id: active.activity.id, outcomeRef: 'outcome://pending' },
      });
      await expect(updatePersonaActivityReferences({
        ...fence(active),
        runId: 'run_stale',
      })).rejects.toBeInstanceOf(PersonaLeaseLostError);
      expect(await getPersonaMailboxItem(active.mailboxItem.id)).toMatchObject({
        status: 'completed',
      });
    });
  });
});
