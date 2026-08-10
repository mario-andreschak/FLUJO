import { randomUUID } from 'crypto';

const runFlowMock = jest.fn();
const loadConversationStateMock = jest.fn();
const getFlowMock = jest.fn();
const getPersonaMock = jest.fn();
const getPersonaDeletionTombstoneMock = jest.fn();
const listBindingsMock = jest.fn();
const getRevisionMock = jest.fn();
const reserveMock = jest.fn();
const heartbeatFactoryMock = jest.fn();
const completeReservationsMock = jest.fn();
const cancelReservationsMock = jest.fn();
const heartbeatStopMock = jest.fn();
const authorityAssertMock = jest.fn();
const authorityCommitMock = jest.fn();

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...args),
}));

jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => loadConversationStateMock(...args),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...args) },
}));

jest.mock('@/backend/services/runResources', () => ({
  copyRunResourceToConversation: jest.fn(),
  getRunResourceLocalPath: jest.fn(),
}));

jest.mock('@/backend/services/enduringAgents/store', () => ({
  getPersona: (...args: unknown[]) => getPersonaMock(...args),
  getPersonaDeletionTombstone: (...args: unknown[]) => getPersonaDeletionTombstoneMock(...args),
  listBehaviorBindings: (...args: unknown[]) => listBindingsMock(...args),
  getBehaviorRevision: (...args: unknown[]) => getRevisionMock(...args),
}));

jest.mock('@/backend/execution/meeting/personaReservations', () => ({
  meetingPersonaReservationAttemptId: (
    meeting: { roundNumber: number; lastEventSeq: number },
    generation = 0,
  ) => `attempt-${generation}-${meeting.roundNumber}-${meeting.lastEventSeq}`,
  reserveMeetingPersonas: (...args: unknown[]) => reserveMock(...args),
  startMeetingPersonaHeartbeat: (...args: unknown[]) => heartbeatFactoryMock(...args),
  completeMeetingPersonaReservations: (...args: unknown[]) =>
    completeReservationsMock(...args),
  cancelMeetingPersonaReservations: (...args: unknown[]) => cancelReservationsMock(...args),
}));

import { MeetingEngine, meetingEngine } from '@/backend/execution/meeting/MeetingEngine';
import { meetingEventBus } from '@/backend/services/meetings/MeetingEventBus';
import {
  createMeeting as createMeetingSnapshot,
  deleteMeeting,
  getMeeting,
  anonymizeMeetingPersonaAttribution,
  retireMeetingPersonaParticipants,
  saveMeeting,
} from '@/backend/services/meetings/store';
import { readMeetingEvents } from '@/backend/services/meetings/eventLog';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { ARCHIVED_MEETING_PARTICIPANT_NAME } from '@/shared/types/meeting';
import type { FlowRunInput } from '@/backend/execution/flow/runFlow';
import { buildPersonaInstructionContext } from '@/backend/services/enduringAgents/personaInstructionContext';

const meetingIds: string[] = [];
const authorityAbort = new AbortController();
const authority = {
  signal: authorityAbort.signal,
  assertCurrent: authorityAssertMock,
  commitWhileCurrent: authorityCommitMock,
};
let leaseLost = false;

function flow(id: string) {
  return {
    id,
    name: id,
    nodes: [{ id: `${id}_start`, type: 'start', data: { type: 'start' } }],
    edges: [],
  };
}

function behaviorRevision(id = 'revision_pinned') {
  return {
    schemaVersion: 1,
    id,
    behaviorId: 'behavior_persona',
    personaId: 'persona_council',
    slotKey: 'primary',
    revision: 2,
    contentHash: 'b'.repeat(64),
    flowSnapshot: flow('flow_pinned_snapshot'),
    source: { kind: 'role_version', roleVersionId: 'role_persona' },
    createdAt: 1,
  };
}

function personaReservation(meetingId: string, participantId: string) {
  const revision = behaviorRevision();
  const activityId = 'activity_meeting';
  return {
    meetingId,
    attemptId: 'attempt-0-0',
    participantId,
    personaId: 'persona_council',
    mailboxItemId: 'mailbox_meeting',
    claim: {
      mailboxItem: { id: 'mailbox_meeting' },
      activity: {
        id: activityId,
        personaId: 'persona_council',
        behaviorRevisionId: revision.id,
      },
      lease: {},
    },
    fence: {
      workspaceId: 'default',
      personaId: 'persona_council',
      activityId: 'activity_meeting',
      leaseId: 'lease_meeting',
      holderId: 'holder_meeting',
      fencingToken: 1,
    },
    revision,
    instructionContext: buildPersonaInstructionContext({
      persona: {
        id: 'persona_council',
        name: 'Living Persona',
        mission: 'Protect the council decision.',
        roleVersionId: 'role_council',
      } as any,
      roleVersion: {
        id: 'role_council',
        name: 'Council Member',
        mission: 'Deliberate according to the pinned Behavior.',
        behaviorSlots: [{ key: 'primary' }],
      } as any,
      revision: revision as any,
      activityId,
    }),
  };
}

async function createMixedMeeting(options: { moderated?: boolean } = {}) {
  const id = `meeting-${randomUUID()}`;
  meetingIds.push(id);
  const personaId = 'living';
  return meetingEngine.create({
    id,
    title: 'Mixed council',
    openingPrompt: 'Coordinate a safe decision.',
    participants: [
      {
        id: personaId,
        name: 'Living Persona',
        personaId: 'persona_council',
        conversationId: `conversation-${randomUUID()}`,
        ...(options.moderated ? { role: 'moderator' as const } : {}),
      },
      {
        id: 'legacy',
        name: 'Legacy Flow',
        flowId: 'flow_legacy',
        conversationId: `conversation-${randomUUID()}`,
      },
    ],
    ...(options.moderated ? { moderatorParticipantId: personaId } : {}),
    policy: {
      maxRounds: 1,
      concurrencyLimit: 2,
      allSilentBehavior: 'continue',
      ...(options.moderated ? { moderatorMode: 'bookends' as const } : {}),
    },
  });
}

function installRunFlow() {
  const states = new Map<string, any>();
  loadConversationStateMock.mockImplementation(async (conversationId: string) =>
    states.get(conversationId));
  runFlowMock.mockImplementation(async (input: FlowRunInput) => {
    const assistant: FlujoChatMessage = {
      role: 'assistant',
      content: `${input.meetingParticipant!.participantName} contribution`,
      id: randomUUID(),
      timestamp: Date.now(),
    };
    const messages = [...(input.messages as FlujoChatMessage[]), assistant];
    const sharedState = {
      messages,
      conversationId: input.conversationId,
      flowId: input.flowId ?? input.flowDefinition?.id,
      meetingParticipant: input.meetingParticipant,
      meetingTurn: { ...input.meetingTurn!, actions: [] },
      personaAttribution: input.personaAttribution,
    };
    states.set(input.conversationId!, sharedState);
    return {
      status: 'completed',
      conversationId: input.conversationId!,
      runId: randomUUID(),
      outputText: assistant.content,
      messages,
      sharedState,
    };
  });
}

beforeEach(() => {
  leaseLost = false;
  runFlowMock.mockReset();
  loadConversationStateMock.mockReset();
  getFlowMock.mockReset().mockImplementation(async (id: string) => flow(id));
  getPersonaMock.mockReset().mockResolvedValue({
    id: 'persona_council',
    provisioningState: 'ready',
    lifecycleState: 'idle',
  });
  getPersonaDeletionTombstoneMock.mockReset().mockResolvedValue(null);
  listBindingsMock.mockReset().mockResolvedValue([{
    id: 'behavior_persona',
    personaId: 'persona_council',
    slotKey: 'primary',
    activeRevisionId: 'revision_pinned',
  }]);
  getRevisionMock.mockReset().mockResolvedValue(behaviorRevision());
  reserveMock.mockReset().mockImplementation(async (meeting: { id: string }) => [
    personaReservation(meeting.id, 'living'),
  ]);
  heartbeatStopMock.mockReset().mockResolvedValue(undefined);
  authorityAssertMock.mockReset().mockResolvedValue(undefined);
  authorityCommitMock.mockReset().mockImplementation(
    async (task: () => Promise<unknown>) => task(),
  );
  heartbeatFactoryMock.mockReset().mockReturnValue({
    authorityFor: (participantId: string) => participantId === 'living' ? authority : undefined,
    lost: () => leaseLost,
    stop: heartbeatStopMock,
  });
  completeReservationsMock.mockReset().mockResolvedValue(undefined);
  cancelReservationsMock.mockReset().mockResolvedValue(undefined);
  installRunFlow();
});

afterEach(async () => {
  for (const id of meetingIds.splice(0)) {
    meetingEventBus.clear(id);
    await deleteMeeting(id);
  }
});

describe('MeetingEngine Persona integration', () => {
  it('runs a mixed barrier with the pinned Persona prompt context while leaving the legacy Flow unchanged', async () => {
    const meeting = await createMixedMeeting();
    expect(meeting.participants.find((participant) => participant.id === 'living'))
      .toMatchObject({ behaviorRevisionId: 'revision_pinned' });
    const completed = await meetingEngine.runToCompletion(meeting.id);

    expect(completed.status).toBe('completed');
    expect(runFlowMock).toHaveBeenCalledTimes(2);
    const inputs = runFlowMock.mock.calls.map(([input]) => input as FlowRunInput);
    const personaInput = inputs.find((input) =>
      input.meetingParticipant?.participantId === 'living')!;
    const legacyInput = inputs.find((input) =>
      input.meetingParticipant?.participantId === 'legacy')!;
    expect(personaInput).toMatchObject({
      flowDefinition: flow('flow_pinned_snapshot'),
      processNodeId: 'flow_pinned_snapshot_start',
      executionAuthority: {
        assertCurrent: expect.any(Function),
        commitWhileCurrent: expect.any(Function),
      },
      personaAttribution: {
        personaId: 'persona_council',
        activityId: 'activity_meeting',
        behaviorRevisionId: 'revision_pinned',
      },
      personaInstructionContext: {
        personaId: 'persona_council',
        activityId: 'activity_meeting',
        behaviorRevisionId: 'revision_pinned',
        personaName: 'Living Persona',
        roleName: 'Council Member',
      },
    });
    expect(personaInput.personaInstructionContext?.instruction)
      .toContain('# TRUSTED PERSONA CONTEXT');
    expect(personaInput.personaInstructionContext?.instruction)
      .toContain('Protect the council decision.');
    expect(personaInput.flowId).toBeUndefined();
    expect(legacyInput).toMatchObject({
      flowId: 'flow_legacy',
      processNodeId: 'flow_legacy_start',
      executionAuthority: {
        assertCurrent: expect.any(Function),
        commitWhileCurrent: expect.any(Function),
      },
    });
    expect(legacyInput.personaAttribution).toBeUndefined();
    expect(legacyInput.personaInstructionContext).toBeUndefined();

    const persistedPersona = (await getMeeting(meeting.id))?.participants.find(
      (participant) => participant.id === 'living',
    );
    expect(persistedPersona).toMatchObject({
      personaId: 'persona_council',
      activityId: 'activity_meeting',
      behaviorRevisionId: 'revision_pinned',
    });
    expect(completeReservationsMock).toHaveBeenCalledWith(
      expect.any(Array),
      'completed',
      undefined,
    );
  });

  it('serializes starts from isolated process runtimes through the durable intent', async () => {
    const meeting = await createMixedMeeting();
    const firstProcess = new MeetingEngine({ isolateProcessRuntime: true });
    const secondProcess = new MeetingEngine({ isolateProcessRuntime: true });
    let reservationEntered!: () => void;
    let releaseReservation!: () => void;
    const entered = new Promise<void>((resolve) => { reservationEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseReservation = resolve; });
    reserveMock.mockImplementationOnce(async (candidate: { id: string }) => {
      reservationEntered();
      await gate;
      return [personaReservation(candidate.id, 'living')];
    });

    const firstStart = firstProcess.start(meeting.id);
    await entered;
    const observed = await secondProcess.start(meeting.id);

    expect(observed.status).toBe('draft');
    expect(reserveMock).toHaveBeenCalledTimes(1);
    releaseReservation();
    await firstStart;
    await expect(firstProcess.runToCompletion(meeting.id)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(reserveMock).toHaveBeenCalledTimes(1);
  });

  it('rejects Flow authority commits when the meeting generation is superseded', async () => {
    const meeting = await createMixedMeeting();
    const baseRun = runFlowMock.getMockImplementation()!;
    let captureAuthority!: (authority: NonNullable<FlowRunInput['executionAuthority']>) => void;
    let releasePersonaTurn!: () => void;
    const authorityCaptured = new Promise<NonNullable<FlowRunInput['executionAuthority']>>(
      (resolve) => { captureAuthority = resolve; },
    );
    const personaTurnGate = new Promise<void>((resolve) => { releasePersonaTurn = resolve; });
    runFlowMock.mockImplementation(async (input: FlowRunInput) => {
      if (input.meetingParticipant?.participantId === 'living') {
        captureAuthority(input.executionAuthority!);
        await personaTurnGate;
      }
      return baseRun(input);
    });

    const run = meetingEngine.runToCompletion(meeting.id);
    const executionAuthority = await authorityCaptured;
    const durable = (await getMeeting(meeting.id))!;
    const successorGeneration = durable.personaReservationGeneration! + 1;
    durable.personaReservationGeneration = successorGeneration;
    durable.personaReservationIntent = {
      generation: successorGeneration,
      attemptId: 'successor-attempt',
      ownerId: 'successor-owner',
      state: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    };
    await saveMeeting(durable);

    await expect(executionAuthority.assertCurrent()).rejects.toThrow(/start intent was lost/i);
    const task = jest.fn().mockResolvedValue('must-not-commit');
    await expect(executionAuthority.commitWhileCurrent!(task))
      .rejects.toThrow(/start intent was lost/i);
    expect(task).not.toHaveBeenCalled();
    expect(authorityAssertMock).not.toHaveBeenCalled();
    expect(authorityCommitMock).not.toHaveBeenCalled();

    const cancellingProcess = new MeetingEngine({ isolateProcessRuntime: true });
    await cancellingProcess.cancel(meeting.id, 'Successor cancelled the meeting.');
    releasePersonaTurn();
    await expect(run).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('does not resurrect anonymized Persona evidence when an in-flight turn settles late', async () => {
    const meeting = await createMixedMeeting();
    const baseRun = runFlowMock.getMockImplementation()!;
    let signalPersonaTurn!: () => void;
    let releasePersonaTurn!: () => void;
    const personaTurnStarted = new Promise<void>((resolve) => { signalPersonaTurn = resolve; });
    const personaTurnGate = new Promise<void>((resolve) => { releasePersonaTurn = resolve; });
    runFlowMock.mockImplementation(async (input: FlowRunInput) => {
      if (input.meetingParticipant?.participantId === 'living') {
        signalPersonaTurn();
        await personaTurnGate;
      }
      return baseRun(input);
    });

    const run = meetingEngine.runToCompletion(meeting.id);
    await personaTurnStarted;
    await expect(anonymizeMeetingPersonaAttribution('persona_council')).resolves.toMatchObject({
      meetings: 1,
      participants: 1,
    });
    const afterArchive = (await getMeeting(meeting.id))!;
    expect(afterArchive.participants.find((participant) => participant.id === 'living'))
      .toEqual(expect.objectContaining({
        name: ARCHIVED_MEETING_PARTICIPANT_NAME,
        personaArchived: true,
        personaRetired: true,
        status: 'left',
      }));

    releasePersonaTurn();
    await expect(run).rejects.toThrow(/start intent was lost/i);
    const afterSettlement = (await getMeeting(meeting.id))!;
    const events = await readMeetingEvents(meeting.id);
    expect(afterSettlement).toEqual(afterArchive);
    expect(JSON.stringify({ afterSettlement, events })).not.toContain('persona_council');
    expect(JSON.stringify({ afterSettlement, events })).not.toContain('Living Persona');
    await expect(anonymizeMeetingPersonaAttribution('persona_council'))
      .resolves.toEqual({ meetings: 0, participants: 0, events: 0 });
  });

  it('recovers remaining participants without validating or admitting a retained retired Persona', async () => {
    const meeting = await createMixedMeeting();
    await expect(retireMeetingPersonaParticipants('persona_council'))
      .resolves.toEqual({ meetings: 1, participants: 1 });
    getPersonaMock.mockClear();
    listBindingsMock.mockClear();
    getRevisionMock.mockClear();
    reserveMock.mockClear();
    runFlowMock.mockClear();

    const recoveredEngine = new MeetingEngine({ isolateProcessRuntime: true });
    await expect(recoveredEngine.runToCompletion(meeting.id)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(getPersonaMock).not.toHaveBeenCalled();
    expect(listBindingsMock).not.toHaveBeenCalled();
    expect(getRevisionMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
    expect(runFlowMock.mock.calls.map(([input]) =>
      (input as FlowRunInput).meetingParticipant?.participantId)).toEqual(['legacy']);
    expect((await getMeeting(meeting.id))?.participants.find(
      (participant) => participant.id === 'living',
    )).toEqual(expect.objectContaining({
      personaId: 'persona_council',
      personaRetired: true,
      status: 'left',
    }));
  });

  it('closes claimed Persona Activities as cancelled from durable cross-process state', async () => {
    const meeting = await createMixedMeeting();
    let signalClaimed!: () => void;
    let releaseClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { signalClaimed = resolve; });
    const claimedGate = new Promise<void>((resolve) => { releaseClaimed = resolve; });
    const startingProcess = new MeetingEngine({
      isolateProcessRuntime: true,
      failpoints: {
        afterAdmissionBeforeRunningPersist: async () => {
          signalClaimed();
          await claimedGate;
        },
      },
    });
    const cancellingProcess = new MeetingEngine({ isolateProcessRuntime: true });

    const start = startingProcess.start(meeting.id);
    await claimed;
    await expect(cancellingProcess.cancel(meeting.id, 'Cancelled elsewhere.'))
      .resolves.toMatchObject({ status: 'cancelled' });
    releaseClaimed();
    await expect(start).rejects.toThrow(/start intent was lost/i);

    expect(completeReservationsMock).toHaveBeenCalledWith(
      expect.any(Array),
      'cancelled',
      undefined,
    );
    expect(completeReservationsMock).not.toHaveBeenCalledWith(
      expect.any(Array),
      'error',
      expect.anything(),
    );
  });

  it('starts a distinct Persona reservation attempt after reconciling a committed round', async () => {
    const meeting = await createMixedMeeting();
    const priorAttemptId = `attempt-0-${meeting.roundNumber}-${meeting.lastEventSeq}`;
    const roundId = `${meeting.id}-round-1`;
    const participantTurnIds = {
      living: `${roundId}:living`,
      legacy: `${roundId}:legacy`,
    };
    meeting.status = 'running';
    meeting.phase = 'discussion';
    meeting.roundNumber = 1;
    meeting.activeRound = {
      id: roundId,
      number: 1,
      phase: 'discussion',
      status: 'running',
      snapshotSeq: meeting.lastEventSeq,
      eligibleParticipantIds: ['living', 'legacy'],
      participantTurnIds,
      startedAt: Date.now(),
    };
    await saveMeeting(meeting);
    await meetingEventBus.emitBatch(meeting.id, `${roundId}:commit`, [{
      type: 'round:completed',
      audience: 'public',
      roundId,
      roundNumber: 1,
      participantTurnIds,
      eventId: `${roundId}:completed`,
    }]);

    const recovered = await meetingEngine.reconcileInterrupted(meeting.id);
    expect(recovered).toMatchObject({
      status: 'paused',
      activeRound: { id: roundId, status: 'completed' },
    });
    await expect(meetingEngine.runToCompletion(meeting.id)).resolves.toMatchObject({
      status: 'completed',
    });

    const options = reserveMock.mock.calls.at(-1)?.[1] as { attemptId?: string } | undefined;
    expect(options?.attemptId).toBe(`attempt-1-1-${recovered!.lastEventSeq}`);
    expect(options?.attemptId).not.toBe(priorAttemptId);
    expect(reserveMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      participants: expect.arrayContaining([
        expect.objectContaining({
          id: 'living',
          behaviorRevisionId: 'revision_pinned',
        }),
      ]),
    }));
  });

  it('fails closed after recovery when the Persona binding changed from the durable pin', async () => {
    const meeting = await createMixedMeeting();
    const roundId = `${meeting.id}-round-1`;
    const participantTurnIds = {
      living: `${roundId}:living`,
      legacy: `${roundId}:legacy`,
    };
    meeting.status = 'running';
    meeting.phase = 'discussion';
    meeting.roundNumber = 1;
    meeting.activeRound = {
      id: roundId,
      number: 1,
      phase: 'discussion',
      status: 'running',
      snapshotSeq: meeting.lastEventSeq,
      eligibleParticipantIds: ['living', 'legacy'],
      participantTurnIds,
      startedAt: Date.now(),
    };
    await saveMeeting(meeting);
    await meetingEventBus.emitBatch(meeting.id, `${roundId}:commit`, [{
      type: 'round:completed',
      audience: 'public',
      roundId,
      roundNumber: 1,
      participantTurnIds,
      eventId: `${roundId}:completed`,
    }]);
    await expect(meetingEngine.reconcileInterrupted(meeting.id)).resolves.toMatchObject({
      status: 'paused',
      activeRound: { status: 'completed' },
    });

    listBindingsMock.mockResolvedValue([{
      id: 'behavior_persona',
      personaId: 'persona_council',
      slotKey: 'primary',
      activeRevisionId: 'revision_rebound',
    }]);
    getRevisionMock.mockResolvedValue({
      ...behaviorRevision('revision_rebound'),
      flowSnapshot: flow('flow_rebound_snapshot'),
    });

    await expect(meetingEngine.start(meeting.id)).rejects.toThrow(
      /pinned to Behavior revision revision_pinned.*now points to revision_rebound/i,
    );
    expect(reserveMock).not.toHaveBeenCalled();
    expect(runFlowMock).not.toHaveBeenCalled();
    expect((await getMeeting(meeting.id))?.participants.find(
      (participant) => participant.id === 'living',
    )).toMatchObject({ behaviorRevisionId: 'revision_pinned' });
  });

  it('durably backfills a missing pin on a legacy Persona meeting before reservation', async () => {
    const id = `meeting-${randomUUID()}`;
    meetingIds.push(id);
    const legacySnapshot = await createMeetingSnapshot({
      id,
      title: 'Pre-pin mixed council',
      openingPrompt: 'Resume without changing Behavior.',
      participants: [
        {
          id: 'living',
          name: 'Living Persona',
          personaId: 'persona_council',
          conversationId: `conversation-${randomUUID()}`,
        },
        {
          id: 'legacy',
          name: 'Legacy Flow',
          flowId: 'flow_legacy',
          conversationId: `conversation-${randomUUID()}`,
        },
      ],
      policy: { maxRounds: 1, concurrencyLimit: 2 },
    });
    expect(legacySnapshot.participants.find((participant) => participant.id === 'living'))
      .not.toHaveProperty('behaviorRevisionId');

    await expect(meetingEngine.runToCompletion(id)).resolves.toMatchObject({ status: 'completed' });

    expect((await getMeeting(id))?.participants.find((participant) => participant.id === 'living'))
      .toMatchObject({ behaviorRevisionId: 'revision_pinned' });
    expect(reserveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        participants: expect.arrayContaining([
          expect.objectContaining({
            id: 'living',
            behaviorRevisionId: 'revision_pinned',
          }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it('rejects a missing or ambiguous Persona Behavior binding before durable admission', async () => {
    listBindingsMock.mockResolvedValue([]);
    await expect(createMixedMeeting()).rejects.toThrow(/no Behavior/i);
    expect(reserveMock).not.toHaveBeenCalled();

    listBindingsMock.mockResolvedValue([
      { personaId: 'persona_council', slotKey: 'primary', activeRevisionId: 'revision_1' },
      { personaId: 'persona_council', slotKey: 'primary', activeRevisionId: 'revision_2' },
    ]);
    await expect(createMixedMeeting()).rejects.toThrow(/multiple Behaviors/i);
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('rejects a duplicate Persona before binding lookup or durable meeting creation', async () => {
    const id = `meeting-${randomUUID()}`;
    meetingIds.push(id);
    await expect(meetingEngine.create({
      id,
      title: 'Duplicate council',
      openingPrompt: 'Do not admit duplicates.',
      participants: [
        { id: 'first', name: 'First', personaId: 'persona_council' },
        { id: 'second', name: 'Second', personaId: 'persona_council' },
      ],
    })).rejects.toThrow(/Duplicate Persona participant/i);

    expect(getPersonaMock).not.toHaveBeenCalled();
    expect(listBindingsMock).not.toHaveBeenCalled();
    expect(await getMeeting(id)).toBeNull();
  });

  it('closes the reserved Activity as cancelled after in-flight mixed turns unwind', async () => {
    const meeting = await createMixedMeeting();
    const baseRun = runFlowMock.getMockImplementation()!;
    let started = 0;
    let resolveStarted!: () => void;
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runFlowMock.mockImplementation(async (input: FlowRunInput) => {
      started += 1;
      if (started === 2) resolveStarted();
      await gate;
      return baseRun(input);
    });

    const run = meetingEngine.runToCompletion(meeting.id);
    await allStarted;
    const cancelled = await meetingEngine.cancel(meeting.id, 'Stop the council.');
    expect(cancelled.status).toBe('cancelled');
    release();
    await expect(run).resolves.toMatchObject({ status: 'cancelled' });

    expect(heartbeatStopMock).toHaveBeenCalledTimes(1);
    expect(completeReservationsMock).toHaveBeenCalledWith(
      expect.any(Array),
      'cancelled',
      undefined,
    );
  });

  it('fails the meeting when the Persona lease is lost during the closing turn', async () => {
    const meeting = await createMixedMeeting({ moderated: true });
    const baseRun = runFlowMock.getMockImplementation()!;
    let personaTurns = 0;
    runFlowMock.mockImplementation(async (input: FlowRunInput) => {
      const result = await baseRun(input);
      if (input.meetingParticipant?.participantId === 'living') {
        personaTurns += 1;
        if (personaTurns === 2) leaseLost = true;
      }
      return result;
    });

    const failed = await meetingEngine.runToCompletion(meeting.id);

    expect(personaTurns).toBe(2);
    expect(failed).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/lease was lost/i),
    });
    expect((await readMeetingEvents(meeting.id)).at(-1)?.type).toBe('meeting:error');
    expect(completeReservationsMock).toHaveBeenCalledWith(
      expect.any(Array),
      'error',
      expect.stringMatching(/lease was lost/i),
    );
  });
});
