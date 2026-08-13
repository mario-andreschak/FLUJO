import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  _setPersonaRuntimeEventLogRootForTests,
  appendPersonaRuntimeEvent,
  claimNextPersonaActivity,
  completePersonaActivity,
  createPersonaFromRole,
  deletePersonaRuntimeEvents,
  enqueuePersonaMailboxItem,
  getPersona,
  getPersonaActivity,
  getPersonaMailboxItem,
  inspectAndReconcilePersonaRuntime,
  latestPersonaRuntimeEventSequence,
  listPersonaRuntimeRecoveryReceipts,
  PersonaRuntimeCorruptionError,
  readPersonaRuntimeEvents,
  recoverPersonaRuntime,
} from '@/backend/services/enduringAgents';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import { deleteCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function freshWorkspace(label: string): string {
  workspaceSequence += 1;
  return `runtime-observe-${label}-${process.pid}-${workspaceSequence}`;
}

describe('Persona runtime observability', () => {
  let tempRoot: string;
  let previousRoot: string | undefined;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-runtime-observability-'));
    previousRoot = _setPersonaRuntimeEventLogRootForTests(tempRoot);
  });

  beforeEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });
    _setPersonaRuntimeEventLogRootForTests(tempRoot);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    _setPersonaRuntimeEventLogRootForTests(previousRoot);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('serializes concurrent appends monotonically and deduplicates eventId retries', async () => {
    await runWithWorkspace(freshWorkspace('ordering'), async () => {
      const personaId = 'persona_observed';
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) => appendPersonaRuntimeEvent(personaId, {
          eventId: `admission:${index}`,
          type: 'mailbox:admitted',
          mailboxItemId: `mailbox_${index}`,
          kind: 'assignment',
          priority: 'normal',
          duplicate: false,
        })),
      );
      expect(results.map(({ event }) => event.seq)).toEqual(
        Array.from({ length: 20 }, (_, index) => index),
      );

      const retry = await appendPersonaRuntimeEvent(personaId, {
        eventId: 'admission:0',
        type: 'mailbox:admitted',
        mailboxItemId: 'different_but_ignored_on_retry',
        kind: 'triggered',
        priority: 'urgent',
        duplicate: true,
      });
      expect(retry).toMatchObject({ appended: false, event: { seq: 0 } });
      expect(await latestPersonaRuntimeEventSequence(personaId)).toBe(19);
      expect((await readPersonaRuntimeEvents(personaId)).map(({ seq }) => seq))
        .toEqual(Array.from({ length: 20 }, (_, index) => index));
    });
  });

  it('ignores a malformed crash tail and remains appendable at the next sequence', async () => {
    const workspace = freshWorkspace('tail');
    await runWithWorkspace(workspace, async () => {
      const personaId = 'persona_tail';
      await appendPersonaRuntimeEvent(personaId, {
        eventId: 'claimed:one',
        type: 'activity:claimed',
        activityId: 'activity_one',
        kind: 'assignment',
      });
      const file = path.join(tempRoot, workspace, `${personaId}.jsonl`);
      await fs.appendFile(file, '{"truncated":', 'utf8');
      _setPersonaRuntimeEventLogRootForTests(tempRoot);

      expect(await readPersonaRuntimeEvents(personaId)).toHaveLength(1);
      const next = await appendPersonaRuntimeEvent(personaId, {
        eventId: 'completed:one',
        type: 'activity:completed',
        activityId: 'activity_one',
      });
      expect(next.event.seq).toBe(1);
      expect((await readPersonaRuntimeEvents(personaId)).map(({ eventId }) => eventId))
        .toEqual(['claimed:one', 'completed:one']);
    });
  });

  it('isolates identical Persona and event ids by workspace and deletes idempotently', async () => {
    const personaId = 'persona_same';
    const append = (workspace: string, activityId: string) => runWithWorkspace(workspace, () =>
      appendPersonaRuntimeEvent(personaId, {
        eventId: 'activity:same',
        type: 'activity:completed',
        activityId,
      }));
    const workspaceA = freshWorkspace('a');
    const workspaceB = freshWorkspace('b');
    await append(workspaceA, 'activity_a');
    await append(workspaceB, 'activity_b');

    await runWithWorkspace(workspaceA, async () => {
      expect((await readPersonaRuntimeEvents(personaId))[0]).toMatchObject({
        workspaceId: workspaceA,
        activityId: 'activity_a',
        seq: 0,
      });
      await deletePersonaRuntimeEvents(personaId);
      await expect(deletePersonaRuntimeEvents(personaId)).resolves.toBeUndefined();
      expect(await readPersonaRuntimeEvents(personaId)).toEqual([]);
    });
    await runWithWorkspace(workspaceB, async () => {
      expect((await readPersonaRuntimeEvents(personaId))[0]).toMatchObject({
        workspaceId: workspaceB,
        activityId: 'activity_b',
        seq: 0,
      });
    });
  });

  it('rejects unknown or capability-bearing fields and persists only redacted codes', async () => {
    const workspace = freshWorkspace('redaction');
    await runWithWorkspace(workspace, async () => {
      const personaId = 'persona_redacted';
      await expect(appendPersonaRuntimeEvent(personaId, {
        eventId: 'lease:unsafe',
        type: 'lease:renewed',
        activityId: 'activity_redacted',
        expiresAt: 123,
        leaseId: 'lease_secret',
        holderId: 'holder_secret',
        fencingToken: 99,
      })).rejects.toThrow();
      await expect(appendPersonaRuntimeEvent(personaId, {
        eventId: 'error:unsafe',
        type: 'activity:errored',
        activityId: 'activity_redacted',
        errorCode: 'provider_error',
        error: 'secret-bearing raw error message',
      })).rejects.toThrow();

      await appendPersonaRuntimeEvent(personaId, {
        eventId: 'error:safe',
        type: 'activity:errored',
        activityId: 'activity_redacted',
        errorCode: 'provider_error',
      });
      const serialized = await fs.readFile(
        path.join(tempRoot, workspace, `${personaId}.jsonl`),
        'utf8',
      );
      expect(serialized).not.toMatch(/holderId|leaseId|fencingToken|raw error message/);
      expect(JSON.parse(serialized)).toMatchObject({
        type: 'activity:errored',
        errorCode: 'provider_error',
      });
    });
  });

  it('records cancellation distinctly from successful completion', async () => {
    await runWithWorkspace(freshWorkspace('cancelled'), async () => {
      const { persona } = await createPersonaFromRole({
        id: 'persona_cancelled',
        name: 'Cancelled Persona',
      });
      await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'cancelled-work',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'cancelled-work' },
      });
      const claim = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 10_000 });
      expect(claim).not.toBeNull();
      await completePersonaActivity({
        workspaceId: claim!.lease.workspaceId,
        personaId: persona.id,
        activityId: claim!.activity.id,
        leaseId: claim!.lease.id,
        holderId: claim!.lease.holderId,
        fencingToken: claim!.lease.fencingToken,
        status: 'cancelled',
      });

      const events = await readPersonaRuntimeEvents(persona.id);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'activity:cancelled',
          activityId: claim!.activity.id,
        }),
      ]));
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'activity:completed',
          activityId: claim!.activity.id,
        }),
      ]));
    });
  });

  it('observes and lazily reconciles an expired active lease without exposing its capability', async () => {
    await runWithWorkspace(freshWorkspace('expiry'), async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
      const { persona } = await createPersonaFromRole({
        id: 'persona_expired',
        name: 'Jim',
      });
      await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'expired-work',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'ticket-expired' },
        summary: 'Potentially side-effecting work',
      });
      const claimed = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 1_000 });
      expect(claimed).not.toBeNull();

      nowSpy.mockReturnValue(11_000);
      const inspected = await inspectAndReconcilePersonaRuntime(persona.id);
      expect(inspected).toMatchObject({
        detectedStuckIndicators: expect.arrayContaining(['active_lease_expired']),
        reconciliation: { attempted: true, changed: true, remainingStuck: false },
        projection: {
          lifecycleState: 'idle',
          leaseStatus: 'expired',
          active: null,
          mailbox: { rejected: 1 },
          activities: { terminal: 1 },
          stuck: false,
        },
      });
      expect(inspected!.recentEvents.map(({ type }) => type)).toEqual(
        expect.arrayContaining([
          'stuck:detected',
          'recovery:started',
          'recovery:completed',
        ]),
      );
      const serialized = JSON.stringify(inspected);
      expect(serialized).not.toContain(claimed!.lease.id);
      expect(serialized).not.toContain(claimed!.lease.holderId);
      expect(serialized).not.toMatch(/"leaseId"|"holderId"|"fencingToken"/);

      const eventCount = (await readPersonaRuntimeEvents(persona.id)).length;
      const repeated = await inspectAndReconcilePersonaRuntime(persona.id);
      expect(repeated?.reconciliation).toMatchObject({ attempted: false, changed: false });
      expect(await readPersonaRuntimeEvents(persona.id)).toHaveLength(eventCount);
    });
  });

  it('reports an error gate as still blocked until explicit confirmed recovery', async () => {
    await runWithWorkspace(freshWorkspace('error-gate'), async () => {
      const { persona } = await createPersonaFromRole({
        id: 'persona_error_gate',
        name: 'Errored Persona',
      });
      await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, persona.id, {
        ...persona,
        lifecycleState: 'error',
        updatedAt: persona.updatedAt + 1,
      });

      const blocked = await inspectAndReconcilePersonaRuntime(persona.id);
      expect(blocked).toMatchObject({
        projection: {
          lifecycleState: 'error',
          stuck: true,
          stuckIndicators: ['lifecycle_error_blocks_work'],
        },
        detectedStuckIndicators: ['lifecycle_error_blocks_work'],
        reconciliation: { attempted: true, changed: false, remainingStuck: true },
      });
      expect(blocked!.recentEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'recovery:failed',
          errorCode: 'runtime_still_stuck',
        }),
      ]));
      expect(blocked!.recentEvents).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'recovery:completed' }),
      ]));

      await expect(recoverPersonaRuntime({
        personaId: persona.id,
        confirmation: 'WRONG',
      })).rejects.toThrow();
      const recovered = await recoverPersonaRuntime({
        personaId: persona.id,
        confirmation: 'RECOVER',
      });
      expect(recovered).toMatchObject({
        changed: true,
        lifecycleState: 'idle',
        closedActivityIds: [],
      });
      expect((await inspectAndReconcilePersonaRuntime(persona.id))?.projection)
        .toMatchObject({ lifecycleState: 'idle', stuck: false });
      await expect(recoverPersonaRuntime({
        personaId: persona.id,
        confirmation: 'RECOVER',
      })).resolves.toMatchObject({ changed: false, lifecycleState: 'idle' });
    });
  });

  it('closes uncertain orphan work during explicit recovery and drains later queued work', async () => {
    await runWithWorkspace(freshWorkspace('error-repair'), async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(20_000);
      const { persona } = await createPersonaFromRole({
        id: 'persona_error_repair',
        name: 'Repair Persona',
      });
      const uncertain = await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'uncertain-work',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'uncertain-work' },
      });
      const claim = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 1_000 });
      expect(claim).not.toBeNull();
      const later = await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'later-work',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'later-work' },
      });
      await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.mailboxItems, uncertain.item.id);

      nowSpy.mockReturnValue(21_000);
      await expect(inspectAndReconcilePersonaRuntime(persona.id))
        .rejects.toBeInstanceOf(PersonaRuntimeCorruptionError);
      expect((await getPersona(persona.id))?.lifecycleState).toBe('error');

      const recovered = await recoverPersonaRuntime({
        personaId: persona.id,
        confirmation: 'RECOVER',
      });
      expect(recovered).toMatchObject({
        changed: true,
        lifecycleState: 'idle',
        closedActivityIds: [claim!.activity.id],
      });
      const next = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 1_000 });
      expect(next?.mailboxItem.id).toBe(later.item.id);
    });
  });

  it('rejects a mismatched claimed mailbox owner without projecting the foreign Activity', async () => {
    await runWithWorkspace(freshWorkspace('mismatched-claim-owner'), async () => {
      const { persona } = await createPersonaFromRole({
        id: 'persona_mismatched_claim_owner',
        name: 'Claim Owner Persona',
      });
      await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'foreign-terminal',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'foreign-terminal' },
      });
      const foreignClaim = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 60_000 });
      expect(foreignClaim).not.toBeNull();
      await completePersonaActivity({
        workspaceId: foreignClaim!.lease.workspaceId,
        personaId: persona.id,
        activityId: foreignClaim!.activity.id,
        leaseId: foreignClaim!.lease.id,
        holderId: foreignClaim!.lease.holderId,
        fencingToken: foreignClaim!.lease.fencingToken,
        status: 'completed',
      });
      const foreignBeforeRecovery = await getPersonaActivity(foreignClaim!.activity.id);

      await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'victim-claim',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'victim-claim' },
      });
      const victimClaim = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 60_000 });
      expect(victimClaim).not.toBeNull();
      const victimMailboxBeforeRecovery = await getPersonaMailboxItem(
        victimClaim!.mailboxItem.id,
      );
      expect(victimMailboxBeforeRecovery?.status).toBe('claimed');
      const personaBeforeRecovery = await getPersona(persona.id);
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        victimClaim!.mailboxItem.id,
        {
          ...victimMailboxBeforeRecovery!,
          claimedActivityId: foreignClaim!.activity.id,
          updatedAt: victimMailboxBeforeRecovery!.updatedAt + 1,
        },
      );
      await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, persona.id, {
        ...personaBeforeRecovery!,
        lifecycleState: 'error',
        updatedAt: personaBeforeRecovery!.updatedAt + 1,
      });

      const recovered = await recoverPersonaRuntime({
        personaId: persona.id,
        confirmation: 'RECOVER',
      });
      expect(recovered).toMatchObject({
        changed: true,
        lifecycleState: 'error',
        rejectedMailboxItemIds: [victimClaim!.mailboxItem.id],
      });
      expect(await getPersonaMailboxItem(victimClaim!.mailboxItem.id)).toMatchObject({
        status: 'rejected',
      });
      expect((await getPersonaMailboxItem(victimClaim!.mailboxItem.id))?.claimedActivityId)
        .toBeUndefined();
      expect(await getPersonaActivity(foreignClaim!.activity.id)).toEqual(foreignBeforeRecovery);
      expect(await getPersonaActivity(victimClaim!.activity.id)).toMatchObject({
        id: victimClaim!.activity.id,
        status: 'running',
      });
      expect((await getPersona(persona.id))?.lifecycleState).toBe('error');
      expect(await listPersonaRuntimeRecoveryReceipts(persona.id)).toEqual([]);
    });
  });

  it('retries a committed recovery outbox after audit append failure without losing events', async () => {
    await runWithWorkspace(freshWorkspace('recovery-outbox-retry'), async () => {
      const { persona } = await createPersonaFromRole({
        id: 'persona_recovery_outbox_retry',
        name: 'Recovery Outbox Persona',
      });
      await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'uncertain-claimed-work',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'uncertain-claimed-work' },
      });
      const claim = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 60_000 });
      expect(claim).not.toBeNull();
      await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.leases, persona.id);
      await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.leaseHistory, claim!.lease.id);
      const personaBeforeRecovery = await getPersona(persona.id);
      await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, persona.id, {
        ...personaBeforeRecovery!,
        lifecycleState: 'error',
        updatedAt: personaBeforeRecovery!.updatedAt + 1,
      });

      const invalidRoot = path.join(tempRoot, 'not-a-directory');
      await fs.writeFile(invalidRoot, 'blocks event log directory creation');
      _setPersonaRuntimeEventLogRootForTests(invalidRoot);
      await expect(recoverPersonaRuntime({
        personaId: persona.id,
        confirmation: 'RECOVER',
      })).rejects.toThrow();
      _setPersonaRuntimeEventLogRootForTests(tempRoot);

      expect(await getPersonaActivity(claim!.activity.id)).toMatchObject({
        status: 'error',
        error: 'Administrative runtime recovery closed uncertain work; automatic replay was suppressed.',
      });
      expect(await getPersonaMailboxItem(claim!.mailboxItem.id)).toMatchObject({
        status: 'rejected',
      });
      expect((await getPersona(persona.id))?.lifecycleState).toBe('idle');
      const [receipt] = await listPersonaRuntimeRecoveryReceipts(persona.id);
      expect(receipt).toMatchObject({
        phase: 'committed',
        result: {
          closedActivityIds: [claim!.activity.id],
          rejectedMailboxItemIds: [claim!.mailboxItem.id],
          lifecycleState: 'idle',
        },
      });
      expect(receipt.events).toHaveLength(3);

      // Simulate a second crash after the first outbox entry became durable
      // but before the receipt cursor could be removed. The retry must dedupe
      // that prefix and still append the missing Activity/mailbox observations.
      await appendPersonaRuntimeEvent(persona.id, receipt.events[0]);

      await expect(recoverPersonaRuntime({
        personaId: persona.id,
        confirmation: 'RECOVER',
      })).resolves.toMatchObject({ changed: false, lifecycleState: 'idle' });
      expect(await listPersonaRuntimeRecoveryReceipts(persona.id)).toEqual([]);
      const durableEvents = await readPersonaRuntimeEvents(persona.id);
      for (const event of receipt.events) {
        expect(durableEvents.filter((candidate) => candidate.eventId === event.eventId))
          .toHaveLength(1);
      }

      const eventCount = durableEvents.length;
      await expect(recoverPersonaRuntime({
        personaId: persona.id,
        confirmation: 'RECOVER',
      })).resolves.toMatchObject({ changed: false, lifecycleState: 'idle' });
      expect(await readPersonaRuntimeEvents(persona.id)).toHaveLength(eventCount);
    });
  });
});
