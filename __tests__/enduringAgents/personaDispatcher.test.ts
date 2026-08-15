import type { FlowRunInput, FlowRunResult } from '@/backend/execution/flow/runFlow';
import {
  peekSteeringMessages,
  takeSteeringMessages,
} from '@/backend/execution/flow/steeringInbox';
import {
  PersonaFlowDispatcher,
  type PersonaFlowDispatchRecord,
  type PersonaFlowDispatcherDependencies,
  type SubmitPersonaFlowDispatchInput,
} from '@/backend/services/enduringAgents/personaDispatcher';
import type {
  CompletedPersonaActivity,
  PersonaActivityClaim,
  PersonaLeaseFence,
  RoutePersonaMailboxResult,
} from '@/backend/services/enduringAgents/activityRuntime';
import type {
  BehaviorRevision,
  Persona,
  PersonaActivity,
  PersonaLease,
  PersonaMailboxItem,
  RoleVersion,
} from '@/shared/types/enduringAgent';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function workspace(label: string): string {
  workspaceSequence += 1;
  return `persona-dispatcher-${label}-${process.pid}-${workspaceSequence}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function claimFence(claim: PersonaActivityClaim): PersonaLeaseFence {
  return {
    workspaceId: claim.lease.workspaceId,
    personaId: claim.activity.personaId,
    activityId: claim.activity.id,
    leaseId: claim.lease.id,
    holderId: claim.lease.holderId,
    fencingToken: claim.lease.fencingToken,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForDispatch(
  dispatcher: PersonaFlowDispatcher,
  dispatchId: string,
  predicate: (record: PersonaFlowDispatchRecord | null) => boolean,
  timeoutMs = 2_000,
): Promise<PersonaFlowDispatchRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await dispatcher.get(dispatchId);
    if (predicate(record)) return record;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for dispatch state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function successfulResult(input: FlowRunInput, outputText = 'done'): FlowRunResult {
  return {
    status: 'completed',
    conversationId: input.conversationId!,
    runId: input.runId!,
    outputText,
    messages: [],
    sharedState: {} as FlowRunResult['sharedState'],
  };
}

function dispatchInput(
  personaId: string,
  idempotencyKey: string,
): SubmitPersonaFlowDispatchInput {
  return {
    personaId,
    idempotencyKey,
    kind: 'assignment',
    source: { kind: 'assignment', sourceId: `source-${idempotencyKey}` },
    summary: `Assignment ${idempotencyKey}`,
    flowInput: {
      source: 'api',
      prompt: `Please handle ${idempotencyKey}`,
      mode: 'conversation',
    },
  };
}

interface Harness {
  dispatcher: PersonaFlowDispatcher;
  dependencies: PersonaFlowDispatcherDependencies;
  claims: PersonaActivityClaim[];
  routedClaims: PersonaActivityClaim[];
  mailboxItems: Map<string, PersonaMailboxItem>;
  snapshot: BehaviorRevision['flowSnapshot'];
  makeClaim: (payloadRef: string, mailboxId?: string) => PersonaActivityClaim;
}

function makeHarness(
  workspaceId: string,
  options: {
    autoClaims?: boolean;
    heartbeatIntervalMs?: number;
    enableMemoryMaintenance?: boolean;
    autonomyLevel?: Persona['autonomyLevel'];
  } = {},
): Harness {
  const personaId = 'persona_test';
  const snapshot = {
    id: 'pinned_flow',
    name: 'Pinned immutable Flow',
    nodes: [
      {
        id: 'start',
        type: 'start',
        position: { x: 0, y: 0 },
        data: { label: 'Start', type: 'start', properties: {} },
      },
      {
        id: 'primary',
        type: 'process',
        position: { x: 240, y: 0 },
        data: {
          label: 'Primary',
          type: 'process',
          properties: {
            promptTemplate: 'Handle the Activity.',
            boundModel: 'model-test',
          },
        },
      },
      {
        id: 'finish',
        type: 'finish',
        position: { x: 480, y: 0 },
        data: { label: 'Finish', type: 'finish', properties: {} },
      },
    ],
    edges: [
      { id: 'start-primary', source: 'start', target: 'primary' },
      { id: 'primary-finish', source: 'primary', target: 'finish' },
    ],
  } as unknown as BehaviorRevision['flowSnapshot'];
  const persona = {
    schemaVersion: 1,
    id: personaId,
    name: 'Test Persona',
    roleVersionId: 'role_version',
    mission: 'Represent the user with concise, evidence-backed updates.',
    lifecycleState: 'idle',
    autonomyLevel: options.autonomyLevel ?? 'learn_hints',
    interruptionPolicy: 'queue',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Persona;
  const roleVersion = {
    schemaVersion: 1,
    id: 'role_version',
    roleDefinitionId: 'role_definition',
    version: 1,
    name: 'Test Role',
    mission: 'Complete assigned work while respecting the authored Behavior.',
    behaviorSlots: [
      {
        key: 'primary',
        name: 'Primary',
        flowTemplate: snapshot,
      },
      ...(options.enableMemoryMaintenance ? [{
        key: 'maintain_memory',
        name: 'Maintain memory',
        flowTemplate: snapshot,
      }] : []),
    ],
    ...(options.enableMemoryMaintenance
      ? { defaults: { memory: { candidateLimitPerActivity: 3 } } }
      : {}),
    createdAt: 1,
  } as RoleVersion;
  let sequence = 0;
  const claims: PersonaActivityClaim[] = [];
  const routedClaims: PersonaActivityClaim[] = [];
  const mailboxItems = new Map<string, PersonaMailboxItem>();

  const makeClaim = (payloadRef: string, mailboxId?: string): PersonaActivityClaim => {
    sequence += 1;
    const itemId = mailboxId ?? `mailbox_${sequence}`;
    const activityId = `activity_${sequence}`;
    const now = Date.now();
    const mailboxItem = {
      schemaVersion: 1,
      id: itemId,
      personaId,
      idempotencyKey: 'a'.repeat(64),
      sequence,
      kind: 'assignment',
      priority: 'normal',
      status: 'claimed',
      source: { kind: 'assignment', sourceId: itemId },
      behaviorSlotKey: 'primary',
      payloadRef,
      claimedActivityId: activityId,
      createdAt: now,
      updatedAt: now,
    } as PersonaMailboxItem;
    const activity = {
      schemaVersion: 1,
      id: activityId,
      personaId,
      kind: 'assignment',
      status: 'running',
      source: mailboxItem.source,
      behaviorId: 'behavior_primary',
      behaviorRevisionId: 'revision_pinned',
      leaseId: `lease_${sequence}`,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    } as PersonaActivity;
    const lease = {
      schemaVersion: 1,
      id: `lease_${sequence}`,
      workspaceId,
      personaId,
      activityId,
      holderId: `holder_secret_${sequence}`,
      status: 'active',
      fencingToken: sequence,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: now + 30_000,
    } as PersonaLease;
    return { mailboxItem, activity, lease, recovered: false };
  };

  const routePersonaMailboxItem = jest.fn(async (value: unknown): Promise<RoutePersonaMailboxResult> => {
    const input = value as Record<string, unknown>;
    const baseClaim = makeClaim(String(input.payloadRef));
    const claim = input.kind === 'maintenance'
      ? {
          ...baseClaim,
          mailboxItem: {
            ...baseClaim.mailboxItem,
            kind: 'maintenance' as const,
            source: input.source as PersonaActivity['source'],
            behaviorSlotKey: 'maintain_memory',
          },
          activity: {
            ...baseClaim.activity,
            kind: 'maintenance' as const,
            source: input.source as PersonaActivity['source'],
            behaviorId: 'behavior_maintenance',
            behaviorRevisionId: 'revision_maintenance',
          },
        }
      : baseClaim;
    routedClaims.push(claim);
    if (options.autoClaims !== false) claims.push(claim);
    const item = { ...claim.mailboxItem, status: 'queued' as const, claimedActivityId: undefined };
    mailboxItems.set(item.id, item);
    return { item, decision: 'queued' };
  });
  const claimNextPersonaActivity = jest.fn(async () => {
    for (;;) {
      const claim = claims.shift();
      if (!claim) return null;
      if (mailboxItems.get(claim.mailboxItem.id)?.status === 'rejected') continue;
      return claim;
    }
  });
  const assertPersonaActivityLease = jest.fn(async (value: unknown) => {
    const fence = value as Record<string, unknown>;
    const claim = routedClaims.find((candidate) => candidate.activity.id === fence.activityId)
      ?? claims.find((candidate) => candidate.activity.id === fence.activityId);
    return claim?.lease ?? makeClaim('unused_assert').lease;
  });
  const commitWithPersonaActivityLease = jest.fn(
    async (_value: unknown, task: () => Promise<unknown>) => task(),
  ) as unknown as PersonaFlowDispatcherDependencies['commitWithPersonaActivityLease'];
  const renewPersonaActivityLease = jest.fn(async (value: unknown) => {
    const fence = value as Record<string, unknown>;
    return routedClaims.find((candidate) => candidate.activity.id === fence.activityId)?.lease
      ?? makeClaim('unused_renew').lease;
  });
  const releasePersonaActivityLease = jest.fn(async (value: unknown) => {
    const fence = value as Record<string, unknown>;
    return routedClaims.find((candidate) => candidate.activity.id === fence.activityId)?.lease
      ?? makeClaim('unused_release').lease;
  });
  const completePersonaActivity = jest.fn(async (value: unknown) => {
    const input = value as Record<string, unknown>;
    const now = Date.now();
    const status = (input.status ?? 'completed') as PersonaActivity['status'];
    const claimedActivity = routedClaims.find(
      (candidate) => candidate.activity.id === input.activityId,
    )?.activity;
    return {
      activity: {
        ...(claimedActivity ?? {
          schemaVersion: 1,
          id: String(input.activityId),
          personaId,
          kind: 'assignment',
          source: { kind: 'assignment' },
          behaviorId: 'behavior_primary',
          behaviorRevisionId: 'revision_pinned',
          createdAt: now,
        }),
        status,
        ...(input.outcomeRef ? { outcomeRef: input.outcomeRef } : {}),
        ...(input.error ? { error: input.error } : {}),
        updatedAt: now,
        completedAt: now,
      },
      mailboxItem: {
        schemaVersion: 1,
        id: 'mailbox_terminal',
        personaId,
        idempotencyKey: 'a'.repeat(64),
        sequence: 1,
        kind: 'assignment',
        priority: 'normal',
        status: status === 'cancelled' ? 'cancelled' : status === 'error' ? 'error' : 'completed',
        source: { kind: 'assignment' },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
      lease: {
        schemaVersion: 1,
        id: String(input.leaseId),
        workspaceId,
        personaId,
        activityId: String(input.activityId),
        holderId: String(input.holderId),
        status: 'released',
        fencingToken: Number(input.fencingToken),
        acquiredAt: now,
        renewedAt: now,
        expiresAt: now + 30_000,
        releasedAt: now,
      },
    } as CompletedPersonaActivity;
  });
  const completePersonaActivityWithinRuntimeLock = jest.fn(
    async (value: unknown) => completePersonaActivity(value),
  );
  const observeCompletedPersonaActivity = jest.fn(async () => {});
  const synchronizeAssignedWorkItemFromActivity = jest.fn(async () => null);
  const synchronizeAssignedWorkItemFromActivityWithinRuntimeLock = jest.fn(async () => null);
  const updatePersonaActivityReferences = jest.fn(async (value: unknown) => {
    const input = value as Record<string, unknown>;
    const activity = routedClaims.find((candidate) => candidate.activity.id === input.activityId)?.activity;
    const updated = {
      ...(activity ?? makeClaim('unused_update').activity),
      conversationId: input.conversationId,
      runId: input.runId,
    } as PersonaActivity;
    if (activity) Object.assign(activity, updated);
    return updated;
  });
  const persistPersonaActivitySnapshot = jest.fn(async (value: unknown) => {
    const input = value as Record<string, unknown>;
    const activity = routedClaims.find((candidate) => candidate.activity.id === input.activityId)?.activity;
    if (!activity) throw new Error('Activity snapshot target was not found.');
    return {
      ...activity,
      coreFlowId: input.coreFlowId,
      coreFlowRevisionId: input.coreFlowRevisionId,
      coreAppRefs: input.coreAppRefs,
      instructionContext: input.instructionContext,
      instructionContextDigest: input.instructionContextDigest,
      instructionContextSchemaVersion: input.instructionContextSchemaVersion,
      entryPointPayloadRef: input.entryPointPayloadRef,
      updatedAt: Date.now(),
    } as PersonaActivity;
  });
  const snapshotPersonaCoreAppRefs = jest.fn(async () => []);
  const projectPersonaCoreAppsIntoFlow = jest.fn(async (
    _personaId: string,
    _coreAppRefs: unknown,
    flowDefinition: BehaviorRevision['flowSnapshot'],
  ) => flowDefinition);
  const listPendingPersonaActivityDeliveries = jest.fn(async (value: unknown) => {
    const fence = value as Record<string, unknown>;
    return [...mailboxItems.values()].filter((item) => (
      item.personaId === fence.personaId
      && item.status === 'coalesced'
      && item.targetActivityId === fence.activityId
      && item.deliveryStatus === 'pending'
      && (item.routingDecision === 'steer' || item.routingDecision === 'coalesce')
    ));
  });
  const acknowledgePersonaActivityDelivery = jest.fn(async (value: unknown) => {
    const input = value as Record<string, unknown>;
    const item = mailboxItems.get(String(input.mailboxItemId));
    if (!item) throw new Error('Mailbox delivery was not found.');
    const delivered = {
      ...item,
      deliveryStatus: 'delivered' as const,
      deliveredAt: Date.now(),
      updatedAt: Date.now(),
    };
    mailboxItems.set(delivered.id, delivered);
    return delivered;
  });
  const rejectPersonaActivityDelivery = jest.fn(async (value: unknown) => {
    const input = value as Record<string, unknown>;
    const item = mailboxItems.get(String(input.mailboxItemId));
    if (!item) throw new Error('Mailbox delivery was not found.');
    const rejected = {
      ...item,
      status: 'rejected' as const,
      routingDecision: 'queue' as const,
      targetActivityId: undefined,
      deliveryStatus: undefined,
      deliveredAt: undefined,
      coalescedIntoId: undefined,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    };
    mailboxItems.set(rejected.id, rejected);
    return rejected;
  });
  const cancelPersonaMailboxItem = jest.fn(async (value: unknown) => {
    const input = value as Record<string, unknown>;
    const item = mailboxItems.get(String(input.mailboxItemId));
    if (!item) throw new Error('Mailbox item was not found.');
    const rejected = {
      ...item,
      status: 'rejected' as const,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    };
    mailboxItems.set(rejected.id, rejected);
    return rejected;
  });
  const reprioritizePersonaMailboxItemWithinRuntimeLock = jest.fn(async (value: unknown) => {
    const input = value as Record<string, unknown>;
    const item = mailboxItems.get(String(input.mailboxItemId));
    if (!item) throw new Error('Mailbox item was not found.');
    if (item.status !== 'queued' || item.priority === input.priority) {
      return { item, changed: false };
    }
    const updated = {
      ...item,
      priority: input.priority as PersonaMailboxItem['priority'],
      updatedAt: Math.max(Date.now(), item.updatedAt + 1),
    };
    mailboxItems.set(updated.id, updated);
    return { item: updated, changed: true };
  });
  const movePersonaMailboxItemWithinRuntimeLock = jest.fn(async (value: unknown) => {
    const input = value as Record<string, unknown>;
    const target = mailboxItems.get(String(input.mailboxItemId));
    if (!target) throw new Error('Mailbox item was not found.');
    const neighbors = [...mailboxItems.values()]
      .filter((item) => (
        item.id !== target.id
        && item.status === 'queued'
        && item.kind === 'assignment'
        && item.priority === target.priority
      ))
      .sort((left, right) => left.sequence - right.sequence);
    const neighbor = input.direction === 'earlier'
      ? [...neighbors].reverse().find((item) => item.sequence < target.sequence)
      : neighbors.find((item) => item.sequence > target.sequence);
    if (!neighbor) return { item: target, moved: false };
    mailboxItems.set(target.id, { ...target, sequence: neighbor.sequence });
    mailboxItems.set(neighbor.id, { ...neighbor, sequence: target.sequence });
    return { item: mailboxItems.get(target.id)!, moved: true };
  });
  const yieldPersonaActivityForInterruption = jest.fn(async (value: unknown) => {
    const fence = value as Record<string, unknown>;
    return routedClaims.find((candidate) => candidate.activity.id === fence.activityId)?.lease
      ?? makeClaim('unused_interrupt').lease;
  });
  const yieldPersonaActivityForInterruptionWithinRuntimeLock = jest.fn(
    async (value: unknown) => yieldPersonaActivityForInterruption(value),
  );
  const observeYieldedPersonaActivity = jest.fn(async () => {});
  const getBehaviorRevision = jest.fn(async (id: string) => (
    id === 'revision_pinned' || (id === 'revision_maintenance' && options.enableMemoryMaintenance)
      ? {
          schemaVersion: 1,
          id,
          behaviorId: id === 'revision_maintenance' ? 'behavior_maintenance' : 'behavior_primary',
          personaId,
          slotKey: id === 'revision_maintenance' ? 'maintain_memory' : 'primary',
          revision: 7,
          contentHash: 'b'.repeat(64),
          flowSnapshot: snapshot,
          source: { kind: 'import' },
          createdAt: 1,
        } as BehaviorRevision
      : null
  ));
  const getPersonaActivity = jest.fn(async (id: string) => (
    routedClaims.find((candidate) => candidate.activity.id === id)?.activity ?? null
  ));
  const getPersonaMailboxItem = jest.fn(async (id: string) => mailboxItems.get(id) ?? null);
  const readConversationLog = jest.fn(async () => undefined);
  const runFlow = jest.fn(async (input: FlowRunInput) => successfulResult(input));

  const dependencies: PersonaFlowDispatcherDependencies = {
    routePersonaMailboxItem,
    claimNextPersonaActivity,
    assertPersonaActivityLease,
    commitWithPersonaActivityLease,
    renewPersonaActivityLease,
    releasePersonaActivityLease,
    completePersonaActivity,
    completePersonaActivityWithinRuntimeLock,
    observeCompletedPersonaActivity,
    synchronizeAssignedWorkItemFromActivity,
    synchronizeAssignedWorkItemFromActivityWithinRuntimeLock,
    updatePersonaActivityReferences,
    persistPersonaActivitySnapshot,
    listPendingPersonaActivityDeliveries,
    acknowledgePersonaActivityDelivery,
    rejectPersonaActivityDelivery,
    cancelPersonaMailboxItem,
    reprioritizePersonaMailboxItemWithinRuntimeLock,
    movePersonaMailboxItemWithinRuntimeLock,
    yieldPersonaActivityForInterruption,
    yieldPersonaActivityForInterruptionWithinRuntimeLock,
    observeYieldedPersonaActivity,
    getPersona: jest.fn(async (id: string) => id === personaId ? persona : null),
    getRoleVersion: jest.fn(async (id: string) => id === roleVersion.id ? roleVersion : null),
    getBehaviorRevision,
    getPersonaActivity,
    getPersonaMailboxItem,
    getCoreMemory: jest.fn(async () => []),
    snapshotPersonaCoreAppRefs,
    projectPersonaCoreAppsIntoFlow,
    readConversationLog,
    runFlow,
  };
  const dispatcher = new PersonaFlowDispatcher({
    workspaceId,
    leaseTtlMs: 1_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 25,
    dependencies,
  });
  return {
    dispatcher,
    dependencies,
    claims,
    routedClaims,
    mailboxItems,
    snapshot,
    makeClaim,
  };
}

async function startRelatedDelivery(
  label: string,
  relatedFlowInput?: SubmitPersonaFlowDispatchInput['flowInput'],
) {
  const harness = makeHarness(workspace(label), { heartbeatIntervalMs: 10_000 });
  const runEntered = deferred<FlowRunInput>();
  const finishRun = deferred<FlowRunResult>();
  (harness.dependencies.runFlow as jest.Mock).mockImplementation(async (input: FlowRunInput) => {
    runEntered.resolve(input);
    return finishRun.promise;
  });
  const primary = await harness.dispatcher.submit(
    dispatchInput('persona_test', `${label}-primary`),
  );
  const runInput = await runEntered.promise;
  const target = harness.routedClaims[0].activity;
  (harness.dependencies.routePersonaMailboxItem as jest.Mock).mockImplementationOnce(
    async (value: unknown): Promise<RoutePersonaMailboxResult> => {
      const input = value as Record<string, unknown>;
      const claim = harness.makeClaim(String(input.payloadRef), `mailbox_${label}_related`);
      const item = {
        ...claim.mailboxItem,
        status: 'coalesced' as const,
        claimedActivityId: undefined,
        routingDecision: 'steer' as const,
        targetActivityId: target.id,
        deliveryStatus: 'pending' as const,
        coalescedIntoId: harness.routedClaims[0].mailboxItem.id,
        completedAt: Date.now(),
      };
      harness.mailboxItems.set(item.id, item);
      return { item, decision: 'steered', targetActivityId: target.id };
    },
  );
  const related = await harness.dispatcher.submit({
    ...dispatchInput('persona_test', `${label}-related`),
    ...(relatedFlowInput ? { flowInput: relatedFlowInput } : {}),
    relationKey: runInput.conversationId!,
    relatedAction: 'steer',
  });
  return { harness, primary, related, runInput, finishRun };
}

function peekWorkspaceSteering(
  workspaceId: string,
  conversationId: string,
): readonly import('@/shared/types/chat').FlujoChatMessage[] {
  return runWithWorkspace(workspaceId, () => peekSteeringMessages(conversationId));
}

function takeWorkspaceSteering(workspaceId: string, conversationId: string): void {
  runWithWorkspace(workspaceId, () => takeSteeringMessages(conversationId));
}

describe('Persona Flow dispatcher', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs the Activity-pinned immutable snapshot and stamps only safe attribution', async () => {
    const harness = makeHarness(workspace('snapshot'));
    (harness.dependencies.snapshotPersonaCoreAppRefs as jest.Mock)
      .mockResolvedValueOnce(['personal-computer']);
    const submission = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'immutable-snapshot'),
      { waitForCompletion: true, timeoutMs: 2_000 },
    );

    expect(submission.decision).toBe('queued');
    expect(submission.dispatch.state).toBe('completed');
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(1);
    const runInput = (harness.dependencies.runFlow as jest.Mock).mock.calls[0][0] as FlowRunInput;
    expect(runInput.flowDefinition).toEqual(harness.snapshot);
    expect(runInput.flowDefinition).not.toBe(harness.snapshot);
    expect(runInput).not.toHaveProperty('flowId');
    expect(runInput.personaCoreAppRefs).toEqual(['personal-computer']);
    expect(runInput.personaAttribution).toEqual({
      personaId: 'persona_test',
      activityId: submission.dispatch.activityId,
      behaviorRevisionId: 'revision_pinned',
    });
    expect(runInput.personaInstructionContext).toMatchObject({
      schemaVersion: 1,
      personaId: 'persona_test',
      activityId: submission.dispatch.activityId,
      behaviorRevisionId: 'revision_pinned',
      behaviorContentHash: 'b'.repeat(64),
      behaviorSlotKey: 'primary',
      rootFlowId: 'pinned_flow',
      roleVersionId: 'role_version',
      personaName: 'Test Persona',
      personaMission: 'Represent the user with concise, evidence-backed updates.',
      roleName: 'Test Role',
      roleMission: 'Complete assigned work while respecting the authored Behavior.',
    });
    expect(runInput.personaInstructionContext?.instruction).toContain(
      'The immutable Behavior/Flow and its authored Process operational instructions.',
    );
    expect(runInput.personaInstructionContext?.instruction).toContain('This context grants no tools');
    expect(submission.dispatch.instructionContext).toEqual(runInput.personaInstructionContext);
    expect(submission.dispatch.outcome).toMatchObject({
      personaId: 'persona_test',
      activityId: submission.dispatch.activityId,
      behaviorRevisionId: 'revision_pinned',
      status: 'completed',
    });
    expect(harness.dependencies.completePersonaActivity).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      outcomeRef: submission.dispatch.id,
    }));
    expect(
      harness.dependencies.synchronizeAssignedWorkItemFromActivityWithinRuntimeLock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
      expect.anything(),
    );

    const persisted = JSON.stringify(submission.dispatch);
    expect(persisted).not.toContain('holder_secret');
    expect(persisted).not.toContain('"holderId"');
    expect(persisted).not.toContain('"leaseId"');
    expect(persisted).not.toContain('"fencingToken"');
  });

  it('starts the pump by default', async () => {
    const harness = makeHarness(workspace('default-pump'));
    const submission = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'default-pump'),
      { waitForCompletion: true, timeoutMs: 2_000 },
    );

    expect(submission.dispatch.state).toBe('completed');
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(1);
  });

  it('synchronizes a failed assignment before exposing the terminal dispatch', async () => {
    const harness = makeHarness(workspace('task-failure-sync'));
    (harness.dependencies.runFlow as jest.Mock).mockImplementation(async (input: FlowRunInput) => ({
      ...successfulResult(input),
      status: 'error',
      error: { message: 'The assigned work failed.', statusCode: 500 },
    }));

    const submission = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'task-failure-sync'),
      { waitForCompletion: true, timeoutMs: 2_000 },
    );

    expect(submission.dispatch.state).toBe('error');
    expect(
      harness.dependencies.synchronizeAssignedWorkItemFromActivityWithinRuntimeLock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
      expect.anything(),
    );
  });

  it('runs one restricted memory-maintenance Activity after an authored Activity completes', async () => {
    const harness = makeHarness(workspace('memory-maintenance'), {
      enableMemoryMaintenance: true,
    });
    const authoredProcess = harness.snapshot.nodes.find((node) => node.type === 'process');
    if (authoredProcess?.type === 'process') {
      authoredProcess.data.properties = {
        ...authoredProcess.data.properties,
        personaTools: ['remember'],
      };
    }
    const submission = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'memory-maintenance'),
      { waitForCompletion: true, timeoutMs: 2_000 },
    );

    expect(submission.dispatch).toMatchObject({ state: 'completed', memoryCandidateLimit: 3 });
    await waitUntil(() => (harness.dependencies.runFlow as jest.Mock).mock.calls.length === 2);
    const records = await harness.dispatcher.list('persona_test');
    const maintenance = records.find((record) => record.admission.kind === 'maintenance');
    expect(maintenance).toBeDefined();
    const completedMaintenance = await waitForDispatch(
      harness.dispatcher,
      maintenance!.id,
      (record) => record?.state === 'completed',
    );
    expect(completedMaintenance).toMatchObject({
      state: 'completed',
      admission: expect.objectContaining({
        kind: 'maintenance',
        behaviorSlotKey: 'maintain_memory',
      }),
      maintenancePlan: expect.objectContaining({
        sourceDispatchId: submission.dispatch.id,
        sourceActivityId: submission.dispatch.activityId,
        candidateLimit: 3,
      }),
      maintenanceResult: expect.objectContaining({
        status: 'invalid_output',
        proposedCount: 0,
        createdCount: 0,
        rejectedCount: 0,
        issues: [expect.objectContaining({ code: 'invalid_json' })],
      }),
    });
    const primaryFlow = (harness.dependencies.runFlow as jest.Mock).mock.calls[0][0]
      .flowDefinition as BehaviorRevision['flowSnapshot'];
    const maintenanceFlow = (harness.dependencies.runFlow as jest.Mock).mock.calls[1][0]
      .flowDefinition as BehaviorRevision['flowSnapshot'];
    expect(primaryFlow.nodes.find((node) => node.type === 'process')?.data.properties?.personaTools)
      .toEqual(['remember']);
    expect(maintenanceFlow.nodes.find((node) => node.type === 'process')?.data.properties?.personaTools)
      .toEqual([]);
    expect(maintenanceFlow.nodes.find((node) => node.type === 'process')?.data.properties?.captureVariable)
      .toBe('persona_memory_candidates');
    expect(maintenanceFlow.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'static',
        data: expect.objectContaining({ label: 'Validate and commit memory' }),
      }),
    ]));
    expect(records.filter((record) => record.admission.kind === 'maintenance')).toHaveLength(1);
  });

  it('lets the deterministic maintenance node commit through the dispatcher gateway exactly once', async () => {
    const harness = makeHarness(workspace('memory-maintenance-gateway'), {
      enableMemoryMaintenance: true,
    });
    const commitCalls: string[] = [];
    (harness.dependencies.runFlow as jest.Mock).mockImplementation(async (input: FlowRunInput) => {
      if (input.personaAttribution?.behaviorRevisionId === 'revision_maintenance') {
        const output = '{"memories":[]}';
        const commit = input.executionAuthority?.commitPersonaMemoryMaintenance;
        if (!commit) throw new Error('Expected the maintenance gateway callback.');
        commitCalls.push(output);
        await commit(output);
        return successfulResult(input, output);
      }
      return successfulResult(input);
    });

    await harness.dispatcher.submit(
      dispatchInput('persona_test', 'memory-maintenance-gateway'),
      { waitForCompletion: true, timeoutMs: 2_000 },
    );
    await waitUntil(() => (harness.dependencies.runFlow as jest.Mock).mock.calls.length === 2);
    const maintenance = (await harness.dispatcher.list('persona_test')).find(
      (record) => record.admission.kind === 'maintenance',
    );
    const completed = await waitForDispatch(
      harness.dispatcher,
      maintenance!.id,
      (record) => record?.state === 'completed',
    );

    expect(commitCalls).toEqual(['{"memories":[]}']);
    expect(completed?.maintenanceResult).toMatchObject({
      status: 'no_proposals',
      proposedCount: 0,
      createdCount: 0,
      rejectedCount: 0,
    });
  });

  it('does not learn automatically when the Persona learning control is off', async () => {
    const harness = makeHarness(workspace('memory-maintenance-off'), {
      enableMemoryMaintenance: true,
      autonomyLevel: 'locked',
    });
    const submission = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'memory-maintenance-off'),
      { waitForCompletion: true, timeoutMs: 2_000 },
    );

    expect(submission.dispatch).toMatchObject({ state: 'completed', memoryCandidateLimit: 3 });
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(1);
    expect((await harness.dispatcher.list('persona_test')).filter(
      (record) => record.admission.kind === 'maintenance',
    )).toHaveLength(0);
  });

  it('can persist and route without starting the pump', async () => {
    const harness = makeHarness(workspace('deferred-pump'));
    const submission = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'deferred-pump'),
      { startPump: false },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(submission.dispatch).toMatchObject({ state: 'queued', mailboxItemId: expect.any(String) });
    expect(harness.dependencies.runFlow).not.toHaveBeenCalled();

    await harness.dispatcher.pump('persona_test');
    expect((await harness.dispatcher.get(submission.dispatch.id))?.state).toBe('completed');
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(1);
  });

  it('cancels queued work by its Persona-scoped dispatch id before Activity attribution', async () => {
    const harness = makeHarness(workspace('queued-cancel-by-id'));
    const submission = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'queued-cancel-by-id'),
      { startPump: false },
    );

    expect(submission.dispatch).toMatchObject({ state: 'queued' });
    expect(submission.dispatch.activityId).toBeUndefined();

    const cancelled = await harness.dispatcher.cancelById({
      personaId: 'persona_test',
      dispatchId: submission.dispatch.id,
      reason: 'Task stopped before it started.',
    }, { waitForCompletion: true, timeoutMs: 2_000 });

    expect(cancelled).toMatchObject({
      state: 'cancelled',
      cancellationReason: 'Task stopped before it started.',
    });
    expect(harness.dependencies.runFlow).not.toHaveBeenCalled();
    expect(harness.dependencies.completePersonaActivityWithinRuntimeLock)
      .toHaveBeenCalledWith(
        expect.objectContaining({ status: 'cancelled' }),
        expect.anything(),
      );
  });

  it('updates both durable dispatch and mailbox priority while Task work is queued', async () => {
    const harness = makeHarness(workspace('queued-reprioritize'));
    const submission = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'queued-reprioritize'),
      { startPump: false },
    );

    const updated = await harness.dispatcher.reprioritizeWorkItem({
      personaId: 'persona_test',
      workItemId: 'source-queued-reprioritize',
      priority: 'urgent',
    });

    expect(updated).toHaveLength(1);
    expect(updated[0].admission.priority).toBe('urgent');
    expect(harness.mailboxItems.get(submission.dispatch.mailboxItemId!)?.priority).toBe('urgent');
    expect(harness.dependencies.reprioritizePersonaMailboxItemWithinRuntimeLock)
      .toHaveBeenCalledWith({
        personaId: 'persona_test',
        mailboxItemId: submission.dispatch.mailboxItemId,
        priority: 'urgent',
      }, expect.anything());
  });

  it('moves queued Task dispatches within a same-priority mailbox bucket', async () => {
    const harness = makeHarness(workspace('queued-move'));
    const first = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'queued-move-first'),
      { startPump: false },
    );
    const second = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'queued-move-second'),
      { startPump: false },
    );
    const third = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'queued-move-third'),
      { startPump: false },
    );

    const result = await harness.dispatcher.moveWorkItem({
      personaId: 'persona_test',
      workItemId: 'source-queued-move-third',
      direction: 'earlier',
    });

    expect(result).toEqual({ found: true, moved: true });
    expect(harness.mailboxItems.get(first.dispatch.mailboxItemId!)?.sequence).toBe(1);
    expect(harness.mailboxItems.get(third.dispatch.mailboxItemId!)?.sequence).toBe(2);
    expect(harness.mailboxItems.get(second.dispatch.mailboxItemId!)?.sequence).toBe(3);
    expect(new Set([...harness.mailboxItems.values()].map((item) => item.sequence)).size)
      .toBe(harness.mailboxItems.size);
  });

  it('renews while running, aborts on lease loss, and never completes with a stale fence', async () => {
    const harness = makeHarness(workspace('lease-loss'), { heartbeatIntervalMs: 5 });
    (harness.dependencies.renewPersonaActivityLease as jest.Mock).mockRejectedValue(
      new Error('opaque lease_secret should never persist'),
    );
    (harness.dependencies.runFlow as jest.Mock).mockImplementation((input: FlowRunInput) => (
      new Promise<FlowRunResult>((resolve) => {
        input.abortSignal!.addEventListener('abort', () => {
          resolve({
            ...successfulResult(input),
            status: 'error',
            error: { message: 'aborted', statusCode: 500 },
          });
        }, { once: true });
      })
    ));

    const { dispatch } = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'lease-loss'),
      { waitForCompletion: true, timeoutMs: 2_000 },
    );

    expect(dispatch.state).toBe('error');
    expect(dispatch.error).toMatchObject({ code: 'LEASE_LOST' });
    expect(dispatch.error?.message).not.toContain('lease_secret');
    expect(harness.dependencies.renewPersonaActivityLease).toHaveBeenCalled();
    expect(harness.dependencies.completePersonaActivity).not.toHaveBeenCalled();
  });

  it('drains queued work serially after the active dispatch completes', async () => {
    const harness = makeHarness(workspace('queued'));
    const firstGate = deferred<void>();
    (harness.dependencies.runFlow as jest.Mock)
      .mockImplementationOnce(async (input: FlowRunInput) => {
        await firstGate.promise;
        return successfulResult(input, 'first');
      })
      .mockImplementationOnce(async (input: FlowRunInput) => successfulResult(input, 'second'));

    const first = await harness.dispatcher.submit(dispatchInput('persona_test', 'first'));
    await waitUntil(() => (harness.dependencies.runFlow as jest.Mock).mock.calls.length === 1);
    const second = await harness.dispatcher.submit(dispatchInput('persona_test', 'second'));
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(1);

    firstGate.resolve();
    const [firstDone, secondDone] = await Promise.all([
      harness.dispatcher.wait(first.dispatch.id, { timeoutMs: 2_000 }),
      harness.dispatcher.wait(second.dispatch.id, { timeoutMs: 2_000 }),
    ]);
    expect(firstDone.outcome?.outputText).toBe('first');
    expect(secondDone.outcome?.outputText).toBe('second');
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(2);
  });

  it('yields approval/debug pauses without completing or immediately replaying them', async () => {
    const harness = makeHarness(workspace('pause'));
    (harness.dependencies.runFlow as jest.Mock).mockImplementation(async (input: FlowRunInput) => ({
      ...successfulResult(input),
      status: 'awaiting_tool_approval',
    }));

    const submission = await harness.dispatcher.submit(dispatchInput('persona_test', 'pause'));
    await harness.dispatcher.pump('persona_test');
    const waiting = await harness.dispatcher.get(submission.dispatch.id);

    expect(waiting).toMatchObject({ state: 'waiting', waitingReason: 'approval' });
    expect(harness.dependencies.releasePersonaActivityLease).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.completePersonaActivity).not.toHaveBeenCalled();
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(1);
  });

  it('reacquires the exact waiting Activity and prepares approval state under safe authority', async () => {
    const harness = makeHarness(workspace('resume'));
    (harness.dependencies.runFlow as jest.Mock)
      .mockImplementationOnce(async (input: FlowRunInput) => ({
        ...successfulResult(input),
        status: 'awaiting_tool_approval',
      }))
      .mockImplementationOnce(async (input: FlowRunInput) => successfulResult(input, 'resumed'));
    const submitted = await harness.dispatcher.submit(dispatchInput('persona_test', 'resume'));
    await harness.dispatcher.pump('persona_test');
    const waiting = (await harness.dispatcher.get(submitted.dispatch.id))!;
    expect(waiting).toMatchObject({ state: 'waiting', waitingReason: 'approval' });
    harness.claims.push(harness.routedClaims[0]);

    const state = {} as FlowRunResult['sharedState'];
    const prepare = jest.fn(async (context) => {
      expect(context.dispatch).not.toHaveProperty('leaseId');
      expect(context.dispatch).not.toHaveProperty('holderId');
      expect(context.dispatch).not.toHaveProperty('fencingToken');
      context.installExecutionAuthority(state);
      expect(Object.keys(state)).not.toContain('executionAuthority');
      await state.executionAuthority!.assertCurrent();
      return 'resume' as const;
    });
    const resumed = await harness.dispatcher.resume({
      personaId: waiting.personaId,
      activityId: waiting.activityId!,
      behaviorRevisionId: waiting.behaviorRevisionId!,
      conversationId: waiting.flowInput!.conversationId,
      reason: 'approval',
      prepare,
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(resumed).toMatchObject({ state: 'completed', outcome: { outputText: 'resumed' } });
    const resumedInput = (harness.dependencies.runFlow as jest.Mock).mock.calls[1][0] as FlowRunInput;
    const initialInput = (harness.dependencies.runFlow as jest.Mock).mock.calls[0][0] as FlowRunInput;
    expect(resumedInput.flowDefinition).toEqual(harness.snapshot);
    expect(resumedInput.personaAttribution).toEqual({
      personaId: waiting.personaId,
      activityId: waiting.activityId,
      behaviorRevisionId: waiting.behaviorRevisionId,
    });
    expect(resumedInput.personaInstructionContext).toEqual(initialInput.personaInstructionContext);
    expect(resumedInput.personaInstructionContext).toEqual(waiting.instructionContext);
    expect(harness.dependencies.getRoleVersion).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(resumed)).not.toMatch(/holderId|leaseId|fencingToken|holder_secret/);
  });

  it('does not guess or backfill instruction context for a started legacy dispatch', async () => {
    const harness = makeHarness(workspace('legacy-context'));
    (harness.dependencies.runFlow as jest.Mock)
      .mockImplementationOnce(async (input: FlowRunInput) => ({
        ...successfulResult(input),
        status: 'awaiting_tool_approval',
      }))
      .mockImplementationOnce(async (input: FlowRunInput) => successfulResult(input, 'legacy-resumed'));
    const submitted = await harness.dispatcher.submit(dispatchInput('persona_test', 'legacy-context'));
    await harness.dispatcher.pump('persona_test');
    const waiting = (await harness.dispatcher.get(submitted.dispatch.id))!;

    // Simulate a waiting record written before the instruction-context field
    // existed. `startedAt` is the durable boundary that forbids re-resolution.
    const internals = harness.dispatcher as unknown as {
      save: (record: PersonaFlowDispatchRecord) => Promise<PersonaFlowDispatchRecord>;
    };
    await internals.save({ ...waiting, instructionContext: undefined });
    (harness.dependencies.getRoleVersion as jest.Mock).mockClear();
    harness.claims.push(harness.routedClaims[0]);

    const resumed = await harness.dispatcher.resume({
      personaId: waiting.personaId,
      activityId: waiting.activityId!,
      behaviorRevisionId: waiting.behaviorRevisionId!,
      conversationId: waiting.flowInput!.conversationId,
      reason: 'approval',
      prepare: async () => 'resume' as const,
    });

    expect(resumed).toMatchObject({ state: 'completed', outcome: { outputText: 'legacy-resumed' } });
    const resumedInput = (harness.dependencies.runFlow as jest.Mock).mock.calls[1][0] as FlowRunInput;
    expect(resumedInput.personaInstructionContext).toBeUndefined();
    expect(harness.dependencies.getRoleVersion).not.toHaveBeenCalled();
  });

  it('yields a partially resolved approval without invoking the Flow again', async () => {
    const harness = makeHarness(workspace('resume-yield'));
    (harness.dependencies.runFlow as jest.Mock).mockImplementationOnce(async (input: FlowRunInput) => ({
      ...successfulResult(input),
      status: 'awaiting_tool_approval',
    }));
    const submitted = await harness.dispatcher.submit(dispatchInput('persona_test', 'resume-yield'));
    await harness.dispatcher.pump('persona_test');
    const waiting = (await harness.dispatcher.get(submitted.dispatch.id))!;
    harness.claims.push(harness.routedClaims[0]);

    const yielded = await harness.dispatcher.resume({
      personaId: waiting.personaId,
      activityId: waiting.activityId!,
      behaviorRevisionId: waiting.behaviorRevisionId!,
      conversationId: waiting.flowInput!.conversationId,
      reason: 'approval',
      prepare: async () => 'yield' as const,
    });

    expect(yielded).toMatchObject({
      state: 'waiting',
      waitingReason: 'approval',
      resumePreparationRequired: false,
    });
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.releasePersonaActivityLease).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.completePersonaActivity).not.toHaveBeenCalled();
  });

  it('fails a restart-lost resume preparation closed instead of replaying it', async () => {
    const workspaceId = workspace('resume-restart');
    const harness = makeHarness(workspaceId);
    (harness.dependencies.runFlow as jest.Mock).mockImplementationOnce(async (input: FlowRunInput) => ({
      ...successfulResult(input),
      status: 'paused_debug',
    }));
    const submitted = await harness.dispatcher.submit(dispatchInput('persona_test', 'resume-restart'));
    await harness.dispatcher.pump('persona_test');
    const waiting = (await harness.dispatcher.get(submitted.dispatch.id))!;

    // Queue the durable marker while this instance cannot reacquire. Its
    // process-local callback disappears when the instance is replaced.
    await harness.dispatcher.resume({
      personaId: waiting.personaId,
      activityId: waiting.activityId!,
      behaviorRevisionId: waiting.behaviorRevisionId!,
      conversationId: waiting.flowInput!.conversationId,
      reason: 'debug',
      prepare: async () => 'resume' as const,
    });
    harness.claims.push(harness.routedClaims[0]);
    const restarted = new PersonaFlowDispatcher({
      workspaceId,
      leaseTtlMs: 1_000,
      heartbeatIntervalMs: 25,
      dependencies: harness.dependencies,
    });
    await restarted.reconcileAndDrain();

    const failedClosed = await restarted.get(waiting.id);
    expect(failedClosed).toMatchObject({
      state: 'waiting',
      waitingReason: 'debug',
      lastError: { code: 'RESUME_PREPARATION_UNAVAILABLE' },
    });
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.completePersonaActivity).not.toHaveBeenCalled();
  });

  it('cancels only the attributed Activity and leaves later Persona work runnable', async () => {
    const harness = makeHarness(workspace('scoped-cancel'));
    (harness.dependencies.runFlow as jest.Mock)
      .mockImplementationOnce(async (input: FlowRunInput) => ({
        ...successfulResult(input),
        status: 'awaiting_tool_approval',
      }))
      .mockImplementationOnce(async (input: FlowRunInput) => successfulResult(input, 'later-work'));
    const submitted = await harness.dispatcher.submit(dispatchInput('persona_test', 'cancel-target'));
    await harness.dispatcher.pump('persona_test');
    const waiting = (await harness.dispatcher.get(submitted.dispatch.id))!;
    harness.claims.push(harness.routedClaims[0]);

    const cancelled = await harness.dispatcher.cancel({
      personaId: waiting.personaId,
      activityId: waiting.activityId!,
      behaviorRevisionId: waiting.behaviorRevisionId!,
      conversationId: waiting.flowInput!.conversationId,
      reason: 'cancel only this conversation',
    }, { waitForCompletion: true, timeoutMs: 2_000 });
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      cancellationReason: 'cancel only this conversation',
    });
    expect(harness.dependencies.completePersonaActivity).toHaveBeenCalledWith(expect.objectContaining({
      activityId: waiting.activityId,
      status: 'cancelled',
    }));
    expect(
      harness.dependencies.synchronizeAssignedWorkItemFromActivityWithinRuntimeLock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: waiting.activityId, status: 'cancelled' }),
      expect.anything(),
    );

    const later = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'after-scoped-cancel'),
      { waitForCompletion: true, timeoutMs: 2_000 },
    );
    expect(later.dispatch).toMatchObject({
      state: 'completed',
      outcome: { outputText: 'later-work' },
    });
    expect(JSON.stringify(cancelled)).not.toMatch(/holderId|leaseId|fencingToken|holder_secret/);
  });

  it('cannot erase cancellation between a resume running read and save', async () => {
    const harness = makeHarness(workspace('running-cancel-race'), {
      heartbeatIntervalMs: 10_000,
    });
    (harness.dependencies.runFlow as jest.Mock)
      .mockImplementationOnce(async (input: FlowRunInput) => ({
        ...successfulResult(input),
        status: 'awaiting_tool_approval',
      }))
      .mockImplementationOnce(async (input: FlowRunInput) => (
        new Promise<FlowRunResult>((resolve) => {
          const finish = () => resolve(successfulResult(input, 'aborted-resume-result'));
          if (input.abortSignal?.aborted) finish();
          else input.abortSignal?.addEventListener('abort', finish, { once: true });
        })
      ));

    const submitted = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'running-cancel-race'),
    );
    await harness.dispatcher.pump('persona_test');
    const waiting = (await harness.dispatcher.get(submitted.dispatch.id))!;
    expect(waiting).toMatchObject({ state: 'waiting', waitingReason: 'approval' });
    harness.claims.push(harness.routedClaims[0]);

    const runningSaveEntered = deferred<void>();
    const releaseRunningSave = deferred<void>();
    const cancellationSaved = deferred<void>();
    const dispatcherInternals = harness.dispatcher as unknown as {
      save: (record: PersonaFlowDispatchRecord) => Promise<PersonaFlowDispatchRecord>;
      findOwningDispatch: (identity: unknown) => Promise<PersonaFlowDispatchRecord>;
    };
    const originalSave = dispatcherInternals.save.bind(harness.dispatcher);
    let interceptedPreparedRunning = false;
    jest.spyOn(dispatcherInternals, 'save').mockImplementation(async (record) => {
      if (
        !interceptedPreparedRunning
        && record.state === 'running'
        && record.resumePreparationRequired === false
        && record.resumeRequestedAt !== undefined
        && !record.cancellationRequestedAt
      ) {
        interceptedPreparedRunning = true;
        runningSaveEntered.resolve();
        await releaseRunningSave.promise;
      }
      const saved = await originalSave(record);
      if (record.cancellationReason === 'cancel at running transition') {
        cancellationSaved.resolve();
      }
      return saved;
    });

    const resumed = harness.dispatcher.resume({
      personaId: waiting.personaId,
      activityId: waiting.activityId!,
      behaviorRevisionId: waiting.behaviorRevisionId!,
      conversationId: waiting.flowInput!.conversationId,
      reason: 'approval',
      prepare: async () => 'resume' as const,
    });
    await runningSaveEntered.promise;

    // The cancellation lookup is deliberately allowed to observe `running`.
    // Its marker write must queue behind the same Persona lock held across the
    // transition's read/save barrier.
    const cancelObservedRunning = deferred<PersonaFlowDispatchRecord>();
    const originalFind = dispatcherInternals.findOwningDispatch.bind(harness.dispatcher);
    jest.spyOn(dispatcherInternals, 'findOwningDispatch').mockImplementation(async (identity) => {
      const found = await originalFind(identity);
      cancelObservedRunning.resolve(found);
      return found;
    });
    const cancellation = harness.dispatcher.cancel({
      personaId: waiting.personaId,
      activityId: waiting.activityId!,
      behaviorRevisionId: waiting.behaviorRevisionId!,
      conversationId: waiting.flowInput!.conversationId,
      reason: 'cancel at running transition',
    }, { waitForCompletion: true, timeoutMs: 2_000 });
    expect((await cancelObservedRunning.promise).state).toBe('running');

    const cancellationCrossedBarrier = await Promise.race([
      cancellationSaved.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    releaseRunningSave.resolve();

    const [resumeResult, cancelResult] = await Promise.all([resumed, cancellation]);
    expect(cancellationCrossedBarrier).toBe(false);
    expect(resumeResult).toMatchObject({
      state: 'cancelled',
      cancellationReason: 'cancel at running transition',
    });
    expect(cancelResult.state).toBe('cancelled');
    expect(harness.dependencies.completePersonaActivityWithinRuntimeLock)
      .toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }), expect.anything());
  });

  it('does not let a terminal-error projection erase an earlier cancellation marker', async () => {
    const harness = makeHarness(workspace('terminal-error-cancel'), { heartbeatIntervalMs: 10_000 });
    const runEntered = deferred<FlowRunInput>();
    const finishRun = deferred<FlowRunResult>();
    (harness.dependencies.runFlow as jest.Mock).mockImplementation(async (input: FlowRunInput) => {
      runEntered.resolve(input);
      return finishRun.promise;
    });
    const submitted = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'terminal-error-cancel'),
    );
    const runInput = await runEntered.promise;
    const stale = (await harness.dispatcher.get(submitted.dispatch.id))!;
    const cancellation = harness.dispatcher.cancel({
      personaId: stale.personaId,
      activityId: stale.activityId!,
      behaviorRevisionId: stale.behaviorRevisionId!,
      conversationId: stale.flowInput!.conversationId,
      reason: 'cancel before terminal error',
    }, { waitForCompletion: true, timeoutMs: 2_000 });
    await waitForDispatch(
      harness.dispatcher,
      stale.id,
      (record) => Boolean(record?.cancellationRequestedAt),
    );

    const internals = harness.dispatcher as unknown as {
      saveTerminalError: (
        record: PersonaFlowDispatchRecord,
        error: { code: string; message: string; at: number },
      ) => Promise<PersonaFlowDispatchRecord>;
    };
    const projected = await internals.saveTerminalError(stale, {
      code: 'LEASE_LOST',
      message: 'Lease lost.',
      at: Date.now(),
    });
    expect(projected.cancellationReason).toBe('cancel before terminal error');
    expect((await harness.dispatcher.get(stale.id))?.cancellationRequestedAt).toBeDefined();

    finishRun.resolve(successfulResult(runInput));
    expect((await cancellation).state).toBe('cancelled');
  });

  it('serializes interruption yield projection with cancellation', async () => {
    const harness = makeHarness(workspace('yield-cancel'), { heartbeatIntervalMs: 10_000 });
    const runEntered = deferred<FlowRunInput>();
    const finishRun = deferred<FlowRunResult>();
    (harness.dependencies.runFlow as jest.Mock).mockImplementation(async (input: FlowRunInput) => {
      runEntered.resolve(input);
      return finishRun.promise;
    });
    const submitted = await harness.dispatcher.submit(dispatchInput('persona_test', 'yield-cancel'));
    const runInput = await runEntered.promise;
    const running = (await harness.dispatcher.get(submitted.dispatch.id))!;
    const yieldEntered = deferred<void>();
    const releaseYield = deferred<void>();
    (harness.dependencies.yieldPersonaActivityForInterruptionWithinRuntimeLock as jest.Mock)
      .mockImplementationOnce(async () => {
        yieldEntered.resolve();
        await releaseYield.promise;
        return harness.routedClaims[0].lease;
      });
    const internals = harness.dispatcher as unknown as {
      yieldForInterruption: (
        record: PersonaFlowDispatchRecord,
        fence: PersonaLeaseFence,
      ) => Promise<boolean>;
    };
    const yielded = internals.yieldForInterruption(running, claimFence(harness.routedClaims[0]));
    await yieldEntered.promise;
    const cancellation = harness.dispatcher.cancel({
      personaId: running.personaId,
      activityId: running.activityId!,
      behaviorRevisionId: running.behaviorRevisionId!,
      conversationId: running.flowInput!.conversationId,
      reason: 'cancel during yield',
    }, { waitForCompletion: true, timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await harness.dispatcher.get(running.id))?.cancellationRequestedAt).toBeUndefined();

    releaseYield.resolve();
    expect(await yielded).toBe(true);
    await waitForDispatch(
      harness.dispatcher,
      running.id,
      (record) => Boolean(record?.cancellationRequestedAt),
    );
    finishRun.resolve(successfulResult(runInput));
    expect((await cancellation).state).toBe('cancelled');
  });

  it('does not let stale reconciliation overwrite cancellation', async () => {
    const harness = makeHarness(workspace('reconcile-cancel'), { heartbeatIntervalMs: 10_000 });
    const runEntered = deferred<FlowRunInput>();
    const finishRun = deferred<FlowRunResult>();
    (harness.dependencies.runFlow as jest.Mock).mockImplementation(async (input: FlowRunInput) => {
      runEntered.resolve(input);
      return finishRun.promise;
    });
    const submitted = await harness.dispatcher.submit(dispatchInput('persona_test', 'reconcile-cancel'));
    const runInput = await runEntered.promise;
    const running = (await harness.dispatcher.get(submitted.dispatch.id))!;
    harness.routedClaims[0].activity.status = 'waiting';
    const saveEntered = deferred<void>();
    const releaseSave = deferred<void>();
    const internals = harness.dispatcher as unknown as {
      save: (record: PersonaFlowDispatchRecord) => Promise<PersonaFlowDispatchRecord>;
      reconcileRecord: (record: PersonaFlowDispatchRecord) => Promise<PersonaFlowDispatchRecord>;
    };
    const originalSave = internals.save.bind(harness.dispatcher);
    let intercepted = false;
    jest.spyOn(internals, 'save').mockImplementation(async (record) => {
      if (!intercepted && record.state === 'waiting' && !record.cancellationRequestedAt) {
        intercepted = true;
        saveEntered.resolve();
        await releaseSave.promise;
      }
      return originalSave(record);
    });
    const reconciliation = internals.reconcileRecord(running);
    await saveEntered.promise;
    const cancellation = harness.dispatcher.cancel({
      personaId: running.personaId,
      activityId: running.activityId!,
      behaviorRevisionId: running.behaviorRevisionId!,
      conversationId: running.flowInput!.conversationId,
      reason: 'cancel during reconcile',
    }, { waitForCompletion: true, timeoutMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await harness.dispatcher.get(running.id))?.cancellationRequestedAt).toBeUndefined();

    releaseSave.resolve();
    await reconciliation;
    harness.routedClaims[0].activity.status = 'running';
    await waitForDispatch(
      harness.dispatcher,
      running.id,
      (record) => Boolean(record?.cancellationRequestedAt),
    );
    finishRun.resolve(successfulResult(runInput));
    expect((await cancellation).state).toBe('cancelled');
  });

  it('stops the heartbeat when setup after activation throws', async () => {
    const harness = makeHarness(workspace('heartbeat-cleanup'), { heartbeatIntervalMs: 5 });
    const submitted = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'heartbeat-cleanup'),
      { startPump: false },
    );
    (harness.dependencies.getPersonaActivity as jest.Mock)
      .mockRejectedValueOnce(new Error('failpoint: interruption read'));

    await expect(harness.dispatcher.pump('persona_test'))
      .rejects.toThrow('failpoint: interruption read');
    const renewals = (harness.dependencies.renewPersonaActivityLease as jest.Mock).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.dependencies.renewPersonaActivityLease).toHaveBeenCalledTimes(renewals);
    expect((await harness.dispatcher.get(submitted.dispatch.id))?.state).toBe('running');
  });

  it('merges a delayed route result without regressing a newer running envelope', async () => {
    const harness = makeHarness(workspace('route-merge'), { autoClaims: false });
    const submitted = await harness.dispatcher.submit(
      dispatchInput('persona_test', 'route-merge'),
      { startPump: false },
    );
    const stale = { ...submitted.dispatch, mailboxItemId: undefined, routingDecision: undefined };
    const internals = harness.dispatcher as unknown as {
      enterRunning: (
        record: PersonaFlowDispatchRecord,
        transition: (latest: PersonaFlowDispatchRecord) => PersonaFlowDispatchRecord,
      ) => Promise<{ record: PersonaFlowDispatchRecord; entered: boolean }>;
      applyRouteResult: (
        record: PersonaFlowDispatchRecord,
        routed: RoutePersonaMailboxResult,
      ) => Promise<PersonaFlowDispatchRecord>;
    };
    const running = await internals.enterRunning(submitted.dispatch, (latest) => ({
      ...latest,
      state: 'running',
      activityId: 'activity_route_merge',
      behaviorRevisionId: 'revision_pinned',
      startedAt: Date.now(),
      updatedAt: Math.max(Date.now(), latest.updatedAt),
    }));
    const item = harness.mailboxItems.get(submitted.dispatch.mailboxItemId!)!;
    const merged = await internals.applyRouteResult(stale, { item, decision: 'duplicate' });

    expect(running.entered).toBe(true);
    expect(merged).toMatchObject({
      state: 'running',
      activityId: 'activity_route_merge',
      behaviorRevisionId: 'revision_pinned',
      mailboxItemId: item.id,
    });
  });

  it('serializes post-run cancellation and completion by Persona lock acquisition order', async () => {
    // Cancellation wins: commit its marker after runFlow's optimistic read but
    // before the terminal Activity lock is acquired.
    const cancelWins = makeHarness(workspace('terminal-race-cancel'));
    const afterResultAssertEntered = deferred<void>();
    const releaseAfterResultAssert = deferred<void>();
    let assertionCount = 0;
    (cancelWins.dependencies.assertPersonaActivityLease as jest.Mock).mockImplementation(
      async () => {
        assertionCount += 1;
        if (assertionCount === 2) {
          afterResultAssertEntered.resolve();
          await releaseAfterResultAssert.promise;
        }
        return cancelWins.routedClaims[0].lease;
      },
    );
    const submitted = await cancelWins.dispatcher.submit(
      dispatchInput('persona_test', 'terminal-race-cancel'),
    );
    await afterResultAssertEntered.promise;
    const running = (await cancelWins.dispatcher.get(submitted.dispatch.id))!;
    const cancellation = cancelWins.dispatcher.cancel({
      personaId: running.personaId,
      activityId: running.activityId!,
      behaviorRevisionId: running.behaviorRevisionId!,
      conversationId: running.flowInput!.conversationId,
      reason: 'race cancellation',
    }, { waitForCompletion: true, timeoutMs: 2_000 });
    let cancellationPersisted = false;
    const markerDeadline = Date.now() + 2_000;
    while (!cancellationPersisted && Date.now() < markerDeadline) {
      cancellationPersisted = Boolean(
        (await cancelWins.dispatcher.get(submitted.dispatch.id))?.cancellationRequestedAt,
      );
      if (!cancellationPersisted) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(cancellationPersisted).toBe(true);
    releaseAfterResultAssert.resolve();
    const cancelled = await cancellation;
    expect(cancelled.state).toBe('cancelled');
    expect(cancelWins.dependencies.completePersonaActivityWithinRuntimeLock)
      .toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }), expect.anything());

    // Completion wins: it already owns the Persona lock. A concurrent cancel
    // may observe running, but cannot persist its marker until the completed
    // Activity and completed dispatch record have both been committed.
    const completionWins = makeHarness(workspace('terminal-race-complete'));
    const terminalLockEntered = deferred<void>();
    const releaseTerminalLock = deferred<void>();
    (completionWins.dependencies.completePersonaActivityWithinRuntimeLock as jest.Mock)
      .mockImplementation(async (value: unknown) => {
        terminalLockEntered.resolve();
        await releaseTerminalLock.promise;
        return completionWins.dependencies.completePersonaActivity(value) as Promise<CompletedPersonaActivity>;
      });
    const completionSubmission = await completionWins.dispatcher.submit(
      dispatchInput('persona_test', 'terminal-race-complete'),
    );
    await terminalLockEntered.promise;
    const completing = (await completionWins.dispatcher.get(completionSubmission.dispatch.id))!;
    const cancelObservedRunning = deferred<PersonaFlowDispatchRecord>();
    const dispatcherInternals = completionWins.dispatcher as unknown as {
      findOwningDispatch: (identity: unknown) => Promise<PersonaFlowDispatchRecord>;
    };
    const originalFind = dispatcherInternals.findOwningDispatch.bind(completionWins.dispatcher);
    jest.spyOn(dispatcherInternals, 'findOwningDispatch').mockImplementation(async (identity) => {
      const found = await originalFind(identity);
      cancelObservedRunning.resolve(found);
      return found;
    });
    const lateCancellation = completionWins.dispatcher.cancel({
      personaId: completing.personaId,
      activityId: completing.activityId!,
      behaviorRevisionId: completing.behaviorRevisionId!,
      conversationId: completing.flowInput!.conversationId,
      reason: 'too late',
    }, { waitForCompletion: true, timeoutMs: 2_000 });
    expect((await cancelObservedRunning.promise).state).toBe('running');
    releaseTerminalLock.resolve();
    const completed = await lateCancellation;
    expect(completed.state).toBe('completed');
    expect(completed.cancellationRequestedAt).toBeUndefined();
    expect(completionWins.dependencies.completePersonaActivityWithinRuntimeLock)
      .toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }), expect.anything());
  });

  it('persists steered payloads for fenced delivery without creating a second Activity', async () => {
    const harness = makeHarness(workspace('steered'), { autoClaims: false });
    (harness.dependencies.routePersonaMailboxItem as jest.Mock).mockImplementation(
      async (value: unknown): Promise<RoutePersonaMailboxResult> => {
        const input = value as Record<string, unknown>;
        const claim = harness.makeClaim(String(input.payloadRef), 'mailbox_steered');
        const item = {
          ...claim.mailboxItem,
          status: 'coalesced' as const,
          claimedActivityId: undefined,
          routingDecision: 'steer' as const,
          targetActivityId: 'activity_active',
          deliveryStatus: 'pending' as const,
          coalescedIntoId: 'mailbox_active',
          completedAt: Date.now(),
        };
        harness.mailboxItems.set(item.id, item);
        return {
          item,
          decision: 'steered',
          targetActivityId: 'activity_active',
        };
      },
    );

    const result = await harness.dispatcher.submit({
      ...dispatchInput('persona_test', 'steered'),
      relationKey: 'conversation_related',
      relatedAction: 'steer',
    });

    expect(result).toMatchObject({
      decision: 'steered',
      dispatch: {
        state: 'waiting',
        waitingReason: 'delivery',
        targetActivityId: 'activity_active',
        flowInput: { prompt: 'Please handle steered' },
      },
    });
    expect(harness.dependencies.claimNextPersonaActivity).not.toHaveBeenCalled();
    expect(harness.dependencies.runFlow).not.toHaveBeenCalled();
  });

  it('polls related input into the stable-id inbox without acknowledging or completing it', async () => {
    const setup = await startRelatedDelivery('poll-boundary');
    const authority = setup.runInput.executionAuthority!;
    try {
      await authority.assertCurrent();
      expect(setup.harness.dependencies.listPendingPersonaActivityDeliveries)
        .not.toHaveBeenCalled();

      await authority.pollRelatedInputs!();
      await authority.pollRelatedInputs!();

      expect(peekWorkspaceSteering(
        setup.related.dispatch.workspaceId,
        setup.runInput.conversationId!,
      )).toEqual([
        expect.objectContaining({
          id: setup.related.dispatch.id,
          role: 'user',
          content: `Please handle poll-boundary-related`,
        }),
      ]);
      expect(setup.harness.dependencies.acknowledgePersonaActivityDelivery)
        .not.toHaveBeenCalled();
      expect(await setup.harness.dispatcher.get(setup.related.dispatch.id)).toMatchObject({
        state: 'waiting',
        waitingReason: 'delivery',
      });
      expect(JSON.stringify(setup.runInput.executionAuthority)).not.toMatch(
        /holder_secret|leaseId|fencingToken/,
      );
    } finally {
      takeWorkspaceSteering(setup.related.dispatch.workspaceId, setup.runInput.conversationId!);
      setup.finishRun.resolve(successfulResult(setup.runInput));
      await setup.harness.dispatcher.wait(setup.primary.dispatch.id, { timeoutMs: 2_000 });
    }
  });

  it('fenced-rejects an unsupported related payload instead of stranding it pending', async () => {
    const setup = await startRelatedDelivery('unsupported-delivery', {
      source: 'api',
      mode: 'conversation',
    });
    const authority = setup.runInput.executionAuthority!;
    try {
      await authority.pollRelatedInputs!();

      expect(setup.harness.dependencies.rejectPersonaActivityDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          activityId: setup.harness.routedClaims[0].activity.id,
          mailboxItemId: setup.related.dispatch.mailboxItemId,
        }),
      );
      expect(setup.harness.dependencies.acknowledgePersonaActivityDelivery)
        .not.toHaveBeenCalled();
      expect(setup.harness.mailboxItems.get(setup.related.dispatch.mailboxItemId!))
        .toMatchObject({ status: 'rejected' });
      expect(await setup.harness.dispatcher.get(setup.related.dispatch.id)).toMatchObject({
        state: 'error',
        error: { code: 'DELIVERY_UNSUPPORTED' },
      });
      expect(peekWorkspaceSteering(
        setup.related.dispatch.workspaceId,
        setup.runInput.conversationId!,
      )).toEqual([]);
    } finally {
      takeWorkspaceSteering(setup.related.dispatch.workspaceId, setup.runInput.conversationId!);
      setup.finishRun.resolve(successfulResult(setup.runInput));
      await setup.harness.dispatcher.wait(setup.primary.dispatch.id, { timeoutMs: 2_000 });
    }
  });

  it('repairs rejection when the process stops before saving the dispatch error', async () => {
    const setup = await startRelatedDelivery('reject-save-crash', {
      source: 'api',
      mode: 'conversation',
    });
    const authority = setup.runInput.executionAuthority!;
    const internals = setup.harness.dispatcher as unknown as {
      save: (record: PersonaFlowDispatchRecord) => Promise<PersonaFlowDispatchRecord>;
    };
    const save = jest.spyOn(internals, 'save')
      .mockRejectedValueOnce(new Error('failpoint: after fenced rejection'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await authority.pollRelatedInputs!();
      expect(setup.harness.mailboxItems.get(setup.related.dispatch.mailboxItemId!))
        .toMatchObject({ status: 'rejected' });
      expect(await setup.harness.dispatcher.get(setup.related.dispatch.id)).toMatchObject({
        state: 'waiting',
        waitingReason: 'delivery',
      });
      save.mockRestore();

      const restarted = new PersonaFlowDispatcher({
        workspaceId: setup.related.dispatch.workspaceId,
        leaseTtlMs: 1_000,
        heartbeatIntervalMs: 10_000,
        dependencies: setup.harness.dependencies,
      });
      await restarted.reconcileAndDrain();
      expect(await restarted.get(setup.related.dispatch.id)).toMatchObject({
        state: 'error',
        error: { code: 'DELIVERY_UNSUPPORTED' },
      });
    } finally {
      save.mockRestore();
      consoleError.mockRestore();
      takeWorkspaceSteering(setup.related.dispatch.workspaceId, setup.runInput.conversationId!);
      setup.finishRun.resolve(successfulResult(setup.runInput));
      await setup.harness.dispatcher.wait(setup.primary.dispatch.id, { timeoutMs: 2_000 });
    }
  });

  it('commits transcript work under the lease and retries ACK after the durability boundary', async () => {
    const setup = await startRelatedDelivery('transcript-ack');
    const authority = setup.runInput.executionAuthority!;
    try {
      await authority.pollRelatedInputs!();
      let transcriptCommitted = false;
      await authority.commitWhileCurrent!(async () => {
        transcriptCommitted = true;
      });
      expect(transcriptCommitted).toBe(true);
      expect(setup.harness.dependencies.commitWithPersonaActivityLease)
        .toHaveBeenCalledTimes(1);

      (setup.harness.dependencies.acknowledgePersonaActivityDelivery as jest.Mock)
        .mockRejectedValueOnce(new Error('failpoint: before mailbox ACK'));
      await expect(authority.acknowledgeRelatedInputs!([setup.related.dispatch.id]))
        .rejects.toThrow('failpoint');
      expect(setup.harness.mailboxItems.get(setup.related.dispatch.mailboxItemId!))
        .toMatchObject({ deliveryStatus: 'pending' });
      expect(await setup.harness.dispatcher.get(setup.related.dispatch.id))
        .toMatchObject({ state: 'waiting', waitingReason: 'delivery' });

      await authority.acknowledgeRelatedInputs!([setup.related.dispatch.id]);
      expect(setup.harness.mailboxItems.get(setup.related.dispatch.mailboxItemId!))
        .toMatchObject({ deliveryStatus: 'delivered' });
      expect(await setup.harness.dispatcher.get(setup.related.dispatch.id))
        .toMatchObject({ state: 'completed', outcome: { status: 'steered' } });
    } finally {
      takeWorkspaceSteering(setup.related.dispatch.workspaceId, setup.runInput.conversationId!);
      setup.finishRun.resolve(successfulResult(setup.runInput));
      await setup.harness.dispatcher.wait(setup.primary.dispatch.id, { timeoutMs: 2_000 });
    }
  });

  it('repairs a crash after mailbox ACK and before dispatch completion save', async () => {
    const setup = await startRelatedDelivery('ack-save');
    const authority = setup.runInput.executionAuthority!;
    try {
      await authority.pollRelatedInputs!();
      (setup.harness.dependencies.getPersonaActivity as jest.Mock)
        .mockRejectedValueOnce(new Error('failpoint: after mailbox ACK'));
      await expect(authority.acknowledgeRelatedInputs!([setup.related.dispatch.id]))
        .rejects.toThrow('failpoint');
      expect(setup.harness.mailboxItems.get(setup.related.dispatch.mailboxItemId!))
        .toMatchObject({ deliveryStatus: 'delivered' });
      expect(await setup.harness.dispatcher.get(setup.related.dispatch.id))
        .toMatchObject({ state: 'waiting', waitingReason: 'delivery' });

      const restarted = new PersonaFlowDispatcher({
        workspaceId: setup.related.dispatch.workspaceId,
        leaseTtlMs: 1_000,
        heartbeatIntervalMs: 10_000,
        dependencies: setup.harness.dependencies,
      });
      await restarted.reconcileAndDrain();
      expect(await restarted.get(setup.related.dispatch.id)).toMatchObject({
        state: 'completed',
        outcome: { status: 'steered' },
      });
    } finally {
      takeWorkspaceSteering(setup.related.dispatch.workspaceId, setup.runInput.conversationId!);
      setup.finishRun.resolve(successfulResult(setup.runInput));
      await setup.harness.dispatcher.wait(setup.primary.dispatch.id, { timeoutMs: 2_000 });
    }
  });

  it('rejects a runtime-requeued delivery when its stable id is already durable', async () => {
    const setup = await startRelatedDelivery('durable-requeue');
    const authority = setup.runInput.executionAuthority!;
    try {
      await authority.pollRelatedInputs!();
      takeWorkspaceSteering(setup.related.dispatch.workspaceId, setup.runInput.conversationId!);
      (setup.harness.dependencies.readConversationLog as jest.Mock).mockResolvedValue([{
        type: 'message',
        message: { id: setup.related.dispatch.id },
      }]);
      const mailboxId = setup.related.dispatch.mailboxItemId!;
      const pending = setup.harness.mailboxItems.get(mailboxId)!;
      setup.harness.mailboxItems.set(mailboxId, {
        ...pending,
        status: 'queued',
        routingDecision: 'queue',
        targetActivityId: undefined,
        deliveryStatus: undefined,
        deliveredAt: undefined,
        completedAt: undefined,
      });
      setup.harness.claims.push(setup.harness.makeClaim(setup.related.dispatch.id, mailboxId));

      const restarted = new PersonaFlowDispatcher({
        workspaceId: setup.related.dispatch.workspaceId,
        leaseTtlMs: 1_000,
        heartbeatIntervalMs: 10_000,
        dependencies: setup.harness.dependencies,
      });
      await restarted.reconcileAndDrain();

      expect(setup.harness.dependencies.cancelPersonaMailboxItem).toHaveBeenCalledWith({
        personaId: 'persona_test',
        mailboxItemId: mailboxId,
      });
      expect(setup.harness.mailboxItems.get(mailboxId)).toMatchObject({ status: 'rejected' });
      expect(await restarted.get(setup.related.dispatch.id)).toMatchObject({
        state: 'completed',
        outcome: { status: 'steered' },
      });
      expect(setup.harness.dependencies.runFlow).toHaveBeenCalledTimes(1);
    } finally {
      takeWorkspaceSteering(setup.related.dispatch.workspaceId, setup.runInput.conversationId!);
      setup.finishRun.resolve(successfulResult(setup.runInput));
      await setup.harness.dispatcher.wait(setup.primary.dispatch.id, { timeoutMs: 2_000 });
    }
  });

  it('reconciles and drains a durable queued dispatch in a fresh dispatcher instance', async () => {
    const workspaceId = workspace('restart');
    const harness = makeHarness(workspaceId, { autoClaims: false });
    const queued = await harness.dispatcher.submit(dispatchInput('persona_test', 'restart'));
    await harness.dispatcher.pump('persona_test');
    expect((await harness.dispatcher.get(queued.dispatch.id))?.state).toBe('queued');

    harness.claims.push(harness.routedClaims[0]);
    const restarted = new PersonaFlowDispatcher({
      workspaceId,
      leaseTtlMs: 1_000,
      heartbeatIntervalMs: 25,
      dependencies: harness.dependencies,
    });
    await restarted.reconcileAndDrain();

    expect((await restarted.get(queued.dispatch.id))?.state).toBe('completed');
    expect(harness.dependencies.runFlow).toHaveBeenCalledTimes(1);
  });

  it('isolates deterministic retry identities and records by workspace', async () => {
    const left = makeHarness(workspace('isolation-left'), { autoClaims: false });
    const right = makeHarness(workspace('isolation-right'), { autoClaims: false });
    const input = dispatchInput('persona_test', 'same-retry');

    const [leftResult, rightResult] = await Promise.all([
      left.dispatcher.submit(input, { startPump: false }),
      right.dispatcher.submit(input, { startPump: false }),
    ]);
    expect(leftResult.dispatch.id).not.toBe(rightResult.dispatch.id);
    expect(await left.dispatcher.get(rightResult.dispatch.id)).toBeNull();
    expect(await right.dispatcher.get(leftResult.dispatch.id)).toBeNull();
    expect((await left.dispatcher.list('persona_test')).map((item) => item.id)).toEqual([
      leftResult.dispatch.id,
    ]);
    expect((await right.dispatcher.list('persona_test')).map((item) => item.id)).toEqual([
      rightResult.dispatch.id,
    ]);
  });

  it('yields non-dispatch claims untouched for MeetingEngine or another owner', async () => {
    const harness = makeHarness(workspace('foreign'), { autoClaims: false });
    harness.claims.push(harness.makeClaim('meeting_payload'));

    await harness.dispatcher.pump('persona_test');

    expect(harness.dependencies.releasePersonaActivityLease).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.completePersonaActivity).not.toHaveBeenCalled();
    expect(harness.dependencies.runFlow).not.toHaveBeenCalled();
    expect(await harness.dispatcher.list()).toEqual([]);
  });

  it('fails a missing dispatcher-owned payload closed and records an observable error', async () => {
    const harness = makeHarness(workspace('missing'), { autoClaims: false });
    const missingId = 'dispatch_missing_payload';
    harness.claims.push(harness.makeClaim(missingId));

    await harness.dispatcher.pump('persona_test');
    const failed = await harness.dispatcher.get(missingId);

    expect(failed).toMatchObject({
      state: 'error',
      error: { code: 'PAYLOAD_MISSING_OR_CORRUPT' },
    });
    expect(harness.dependencies.completePersonaActivity).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
    }));
    expect(harness.dependencies.synchronizeAssignedWorkItemFromActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), status: 'error' }),
    );
    expect(harness.dependencies.runFlow).not.toHaveBeenCalled();
  });
});
