import {
  PERSONA_AUTHORITY_NEGATIVE_CONTROLS,
  PERSONA_INGRESS_MATRIX,
  expectPersonaContinuity,
  type PersonaContinuitySnapshot,
} from './personaIngressMatrix';
import {
  createPersonaProcessEnvironment,
  killOrphanedPersonaChildren,
  removePersonaProcessEnvironment,
  restartPersonaProcess,
  startPersonaProcess,
  waitFor,
  type PersonaLeaseFence,
  type PersonaProcessClient,
  type PersonaProcessEnvironment,
} from './personaProcessBoundaryHarness';

// Several tests spawn two children in sequence, and each spawn has its own
// readiness budget (READINESS_TIMEOUT_MS, 60 s by default). The per-test budget
// has to be able to accommodate that, otherwise a slow runner fails the test
// before the harness can report *why* the child was slow (issue #457).
jest.setTimeout(180_000);

interface CreatedPersona {
  persona: { id: string; roleVersionId: string };
}

interface Enqueued {
  duplicate: boolean;
  item: {
    id: string;
    personaId: string;
    behaviorRevisionId?: string;
    source: { kind: PersonaContinuitySnapshot['sourceKind']; sourceId: string };
    relationKey?: string;
  };
}

interface Routed {
  decision: 'duplicate' | 'queued' | 'steered' | 'coalesced' | 'interrupt_requested';
  targetActivityId?: string;
  item: Enqueued['item'] & {
    targetActivityId?: string;
    deliveryStatus?: string;
    routingDecision?: string;
  };
}

interface Claimed {
  activity: {
    id: string;
    personaId: string;
    kind?: string;
    source?: { kind: string; sourceId?: string };
    behaviorRevisionId?: string;
    instructionContext?: { roleVersionId?: string };
  };
  mailboxItem: Enqueued['item'];
  lease: { fencingToken: number };
  fence: PersonaLeaseFence;
}

function continuitySnapshot(
  claim: Claimed,
  pinnedRoleVersionId: string,
): PersonaContinuitySnapshot {
  return {
    personaId: claim.activity.personaId,
    activityId: claim.activity.id,
    fencingToken: claim.lease.fencingToken,
    behaviorRevisionId: claim.activity.behaviorRevisionId ?? 'legacy-unpinned',
    roleVersionId: claim.activity.instructionContext?.roleVersionId ?? pinnedRoleVersionId,
    relationId: claim.mailboxItem.relationKey ?? claim.mailboxItem.source.sourceId,
    sourceKind: claim.mailboxItem.source.kind,
    sourceId: claim.mailboxItem.source.sourceId,
  };
}

describe('Persona continuity across OS process boundaries', () => {
  let environment: PersonaProcessEnvironment | undefined;
  const clients: PersonaProcessClient[] = [];

  async function start(): Promise<PersonaProcessClient> {
    const client = await startPersonaProcess(environment!);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    environment = await createPersonaProcessEnvironment('continuity');
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
    if (environment) await removePersonaProcessEnvironment(environment);
    environment = undefined;
  });

  afterAll(() => {
    // Belt and braces: a suite abort (or a readiness failure the harness could
    // not reap) must never leave a child process burning CPU.
    killOrphanedPersonaChildren();
  });

  it('keeps the accepted ingress and negative-control matrix explicit', () => {
    expect(PERSONA_INGRESS_MATRIX.map((entry) => entry.label)).toEqual([
      'core chat',
      'related chat injection',
      'explicit assignment',
      'schedule',
      'trigger',
      'meeting',
      'transcript voice',
    ]);
    expect(PERSONA_INGRESS_MATRIX.find((entry) => entry.label === 'meeting')).toMatchObject({
      admission: 'meeting-reservation',
      contention: 'reserve-all-or-none',
    });
    expect(PERSONA_AUTHORITY_NEGATIVE_CONTROLS).toEqual([
      'persona-less-flow',
      'ordinary-subflow',
    ]);
  });

  it('applies the shared Activity lease and pinned-attribution contract to every runtime ingress kind', async () => {
    const child = await start();
    for (const entry of PERSONA_INGRESS_MATRIX) {
      if (entry.admission === 'steering') continue;
      const token = entry.label.replace(/[^a-z]+/g, '-');
      const created = await child.request<CreatedPersona>({
        type: 'createPersona',
        name: `Persona for ${entry.label}`,
        idempotencyKey: `matrix-persona-${token}`,
        coreFlowRef: `core-flow-${token}`,
      });
      const admitted = await child.request<Enqueued>({
        type: 'enqueue',
        input: {
          personaId: created.persona.id,
          idempotencyKey: `matrix-delivery-${token}`,
          kind: entry.mailboxKind,
          source: {
            kind: entry.sourceKind,
            sourceId: `matrix-source-${token}`,
          },
          summary: `Exercise ${entry.label} runtime contract`,
          relationKey: `matrix:${token}`,
        },
      });
      const claimed = await child.request<Claimed>({
        type: 'claim',
        personaId: created.persona.id,
        ttlMs: 30_000,
      });

      expect(claimed).toMatchObject({
        activity: {
          personaId: created.persona.id,
          kind: entry.mailboxKind,
          source: {
            kind: entry.sourceKind,
            sourceId: `matrix-source-${token}`,
          },
        },
        mailboxItem: {
          id: admitted.item.id,
          relationKey: `matrix:${token}`,
        },
      });
      expect(claimed.activity.behaviorRevisionId).toBeTruthy();
      await child.request({ type: 'complete', fence: claimed.fence });
    }
  });

  it('steers related chat and chained voice into one active Activity', async () => {
    const child = await start();
    const created = await child.request<CreatedPersona>({
      type: 'createPersona',
      name: 'Related-input Persona',
      idempotencyKey: 'related-input-persona',
      coreFlowRef: 'core-flow-related-input',
      interruptionPolicy: 'related_only',
    });
    await child.request<Enqueued>({
      type: 'enqueue',
      input: {
        personaId: created.persona.id,
        idempotencyKey: 'active-chat',
        kind: 'interactive_chat',
        source: { kind: 'chat', sourceId: 'conversation-434' },
        summary: 'Start the continuing conversation',
        relationKey: 'conversation:434',
      },
    });
    const active = await child.request<Claimed>({
      type: 'claim',
      personaId: created.persona.id,
      ttlMs: 30_000,
    });

    for (const related of [
      {
        idempotencyKey: 'related-chat',
        kind: 'interactive_chat' as const,
        source: { kind: 'chat' as const, sourceId: 'conversation-434-injection' },
        summary: 'Steer with related chat input',
      },
      {
        idempotencyKey: 'related-voice',
        kind: 'voice' as const,
        source: { kind: 'voice' as const, sourceId: 'voice-session-434' },
        summary: 'Continue with a transcript voice turn',
      },
    ]) {
      const routed = await child.request<Routed>({
        type: 'route',
        input: {
          personaId: created.persona.id,
          ...related,
          relationKey: 'conversation:434',
          relatedAction: 'steer',
        },
      });
      expect(routed).toMatchObject({
        decision: 'steered',
        targetActivityId: active.activity.id,
        item: {
          targetActivityId: active.activity.id,
          deliveryStatus: 'pending',
          routingDecision: 'steer',
        },
      });
    }

    const inspected = await child.request<{
      activities: Array<{ id: string; status: string }>;
    }>({ type: 'inspect', personaId: created.persona.id });
    expect(inspected.activities.filter(({ status }) => status === 'running')).toEqual([
      expect.objectContaining({ id: active.activity.id }),
    ]);
    await child.request({ type: 'complete', fence: active.fence });
  });

  it('restarts against one durable workspace, resumes one Activity, and rejects the stale fence', async () => {
    const firstProcess = await start();
    const created = await firstProcess.request<CreatedPersona>({
      type: 'createPersona',
      name: 'Jim',
      idempotencyKey: 'process-restart-jim',
      coreFlowRef: 'core-flow-process-restart',
    });
    const admitted = await firstProcess.request<Enqueued>({
      type: 'enqueue',
      input: {
        personaId: created.persona.id,
        idempotencyKey: 'process-restart-assignment',
        kind: 'assignment',
        source: {
          kind: 'assignment',
          sourceId: 'ticket-434',
          idempotencyKey: 'ticket-434-delivery',
        },
        summary: 'Continue one Persona across restart',
        relationKey: 'run:run-434',
      },
    });
    expect(admitted.duplicate).toBe(false);

    const before = await firstProcess.request<Claimed>({
      type: 'claim',
      personaId: created.persona.id,
      ttlMs: 30_000,
    });
    expect(before.mailboxItem.id).toBe(admitted.item.id);
    expect(before.activity.behaviorRevisionId).toBeTruthy();
    const released = await firstProcess.request<{ status: string }>({
      type: 'release',
      fence: before.fence,
    });
    expect(released.status).toBe('released');
    await firstProcess.kill();

    const restarted = await restartPersonaProcess(environment!);
    clients.push(restarted);
    const restartedRuntime = await restarted.request<{
      projection: { leaseStatus: string };
      reconciliation: { attempted: boolean; remainingStuck: boolean };
    }>({ type: 'reconcile', personaId: created.persona.id });
    expect(restartedRuntime.projection.leaseStatus).toBe('released');
    expect(restartedRuntime.reconciliation).toMatchObject({
      attempted: false,
      remainingStuck: false,
    });
    await expect(restarted.request({
      type: 'assertFence',
      fence: before.fence,
    })).rejects.toMatchObject({ name: 'PersonaLeaseLostError' });

    const after = await waitFor(
      () => restarted.request<Claimed | null>({
        type: 'claim',
        personaId: created.persona.id,
        ttlMs: 30_000,
      }),
      (claim): claim is Claimed => claim !== null,
      { timeoutMs: 10_000, description: 'released Persona Activity recovery' },
    );
    if (!after) throw new Error('Expected the released Persona Activity to be recovered.');

    expectPersonaContinuity(
      continuitySnapshot(before, created.persona.roleVersionId),
      continuitySnapshot(after, created.persona.roleVersionId),
    );
    expect(after.lease.fencingToken).toBeGreaterThan(before.lease.fencingToken);

    const completed = await restarted.request<{
      activity: { id: string; status: string };
      mailboxItem: { id: string; status: string };
    }>({ type: 'complete', fence: after.fence });
    expect(completed).toMatchObject({
      activity: { id: before.activity.id, status: 'completed' },
      mailboxItem: { id: admitted.item.id, status: 'completed' },
    });
  });

  it('serializes independent process claims to one current lease', async () => {
    const creator = await start();
    const contender = await start();
    const created = await creator.request<CreatedPersona>({
      type: 'createPersona',
      name: 'Sarah',
      idempotencyKey: 'process-contention-sarah',
      coreFlowRef: 'core-flow-process-contention',
    });
    await creator.request({
      type: 'enqueue',
      input: {
        personaId: created.persona.id,
        idempotencyKey: 'process-contention-assignment',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'contention-434' },
        summary: 'Only one process may claim this work',
      },
    });

    const results = await Promise.allSettled([
      creator.request<Claimed | null>({
        type: 'claim',
        personaId: created.persona.id,
        ttlMs: 30_000,
      }),
      contender.request<Claimed | null>({
        type: 'claim',
        personaId: created.persona.id,
        ttlMs: 30_000,
      }),
    ]);
    const claims = results.flatMap((result) =>
      result.status === 'fulfilled' && result.value ? [result.value] : [],
    );
    expect(claims).toHaveLength(1);
    await creator.request({ type: 'complete', fence: claims[0].fence })
      .catch(() => contender.request({ type: 'complete', fence: claims[0].fence }));
  });

  it('coalesces identical cross-process retries and preserves conflict visibility', async () => {
    const first = await start();
    const second = await start();
    const created = await first.request<CreatedPersona>({
      type: 'createPersona',
      name: 'Jim',
      idempotencyKey: 'process-idempotency-jim',
      coreFlowRef: 'core-flow-process-idempotency',
    });
    const input = {
      personaId: created.persona.id,
      idempotencyKey: 'same-delivery',
      kind: 'triggered' as const,
      source: {
        kind: 'trigger' as const,
        sourceId: 'trigger-434',
        idempotencyKey: 'trigger-delivery-434',
      },
      summary: 'Handle one trigger delivery',
      relationKey: 'run:trigger-run-434',
    };
    const admitted = await first.request<Enqueued>({ type: 'enqueue', input });
    const retry = await second.request<Enqueued>({ type: 'enqueue', input });
    expect(retry).toEqual({ item: admitted.item, duplicate: true });

    await expect(second.request({
      type: 'enqueue',
      input: { ...input, summary: 'Changed payload under the same key' },
    })).rejects.toMatchObject({ name: 'PersonaMailboxConflictError' });

    const inspected = await first.request<{
      mailboxItems: Array<{ id: string; summary: string }>;
    }>({ type: 'inspect', personaId: created.persona.id });
    expect(inspected.mailboxItems.filter((item) => item.id === admitted.item.id)).toEqual([
      expect.objectContaining({ summary: input.summary }),
    ]);
  });

  it('interleaves cross-process runtime event appends into one gap-free, duplicate-free log', async () => {
    const first = await start();
    const second = await start();
    const personaId = 'persona_event_interleaving';
    const processes = [first, second];
    const total = 12;

    for (let index = 0; index < total; index += 1) {
      const child = processes[index % processes.length];
      const result = await child.request<{
        appended: boolean;
        event: { seq: number; eventId: string };
      }>({
        type: 'appendEvent',
        personaId,
        event: {
          eventId: `interleaved:${index}`,
          type: 'activity:completed',
          activityId: `activity_${index}`,
        },
      });
      // Each process must observe the other process's appends: the sequence
      // is strictly increasing and gap-free across both writers.
      expect(result).toMatchObject({
        appended: true,
        event: { seq: index, eventId: `interleaved:${index}` },
      });
    }

    // An idempotent retry from the process that did NOT write the original
    // must return the durable event instead of appending a duplicate.
    const retry = await second.request<{ appended: boolean; event: { seq: number } }>({
      type: 'appendEvent',
      personaId,
      event: {
        eventId: 'interleaved:0',
        type: 'activity:completed',
        activityId: 'activity_retry_ignored',
      },
    });
    expect(retry).toMatchObject({ appended: false, event: { seq: 0 } });

    const events = await first.request<Array<{ seq: number; eventId: string }>>({
      type: 'readEvents',
      personaId,
    });
    expect(events.map(({ seq }) => seq)).toEqual(
      Array.from({ length: total }, (_, index) => index),
    );
    expect(new Set(events.map(({ eventId }) => eventId)).size).toBe(total);
  });
});
