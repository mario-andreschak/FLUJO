import { randomUUID } from 'crypto';

import type { FlowRunInput, FlowRunResult } from '@/backend/execution/flow/runFlow';
import type { SharedState } from '@/backend/execution/flow/types';
import { meetingEngine } from '@/backend/execution/meeting';
import {
  MEETING_START_INTENT_TTL_MS,
  MeetingEngine,
} from '@/backend/execution/meeting/MeetingEngine';
import { meetingEventBus } from '@/backend/services/meetings/MeetingEventBus';
import { deleteMeeting, getMeeting, saveMeeting } from '@/backend/services/meetings/store';
import { readMeetingEvents } from '@/backend/services/meetings/eventLog';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { MeetingToolAction } from '@/shared/types/meeting';

const runFlowMock = jest.fn<Promise<FlowRunResult>, [FlowRunInput]>();
const loadConversationStateMock = jest.fn<Promise<SharedState | undefined>, [string]>();
const getFlowMock = jest.fn();
const writeRunResourceMock = jest.fn();
const getRunResourceLocalPathMock = jest.fn();

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (input: FlowRunInput) => runFlowMock(input),
}));

jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (conversationId: string) => loadConversationStateMock(conversationId),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: (...args: unknown[]) => getFlowMock(...args) },
}));

jest.mock('@/backend/services/runResources', () => ({
  copyRunResourceToConversation: jest.fn(),
  getRunResourceLocalPath: (...args: unknown[]) => getRunResourceLocalPathMock(...args),
  writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
}));

const meetingIds: string[] = [];

function flow(id: string) {
  return {
    id,
    name: id,
    nodes: [{ id: `${id}-start`, type: 'start', data: { type: 'start' } }],
    edges: [],
  };
}

function installFlowRuntime(
  actionsFor: (input: FlowRunInput) => MeetingToolAction[] = () => [],
): void {
  const states = new Map<string, SharedState>();
  getFlowMock.mockImplementation(async (id: string) => flow(id));
  loadConversationStateMock.mockImplementation(async (conversationId: string) => states.get(conversationId));
  runFlowMock.mockImplementation(async (input) => {
    const participant = input.meetingParticipant!;
    // Make the second roster entry settle first. The event transcript must
    // still commit in roster order.
    if (participant.participantId === 'alpha') {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const assistant: FlujoChatMessage = {
      role: 'assistant',
      content: `${participant.participantName} contribution for ${input.meetingTurn!.roundId}`,
      id: randomUUID(),
      timestamp: Date.now(),
    };
    const messages = [...(input.messages as FlujoChatMessage[]), assistant];
    const state = {
      trackingInfo: { executionId: randomUUID(), startTime: Date.now(), nodeExecutionTracker: [] },
      messages,
      conversationId: input.conversationId,
      flowId: input.flowId,
      meetingParticipant: input.meetingParticipant,
      meetingTurn: {
        ...input.meetingTurn!,
        actions: actionsFor(input),
      },
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costUsd: 0,
        byNode: {},
      },
    } as unknown as SharedState;
    states.set(input.conversationId!, state);
    return {
      status: 'completed',
      conversationId: input.conversationId!,
      runId: randomUUID(),
      outputText: assistant.content as string,
      messages,
      usage: state.usage,
      sharedState: state,
    };
  });
}

async function createMeeting(maxRounds: number) {
  const id = `meeting-${randomUUID()}`;
  meetingIds.push(id);
  return meetingEngine.create({
    id,
    title: 'Design council',
    openingPrompt: 'Choose a safe coordination design and explain the tradeoffs.',
    participants: [
      { id: 'alpha', name: 'Alpha', flowId: 'flow-alpha', conversationId: randomUUID() },
      { id: 'beta', name: 'Beta', flowId: 'flow-beta', conversationId: randomUUID() },
    ],
    policy: { maxRounds, concurrencyLimit: 2, allSilentBehavior: 'continue' },
  });
}

describe('MeetingEngine', () => {
  beforeEach(() => {
    runFlowMock.mockReset();
    loadConversationStateMock.mockReset();
    getFlowMock.mockReset();
    writeRunResourceMock.mockReset();
    getRunResourceLocalPathMock.mockReset();
    writeRunResourceMock.mockImplementation(async ({ conversationId, name }: { conversationId: string; name?: string }) => ({
      id: `resource-${conversationId}`,
      uri: `flujo://run/${conversationId}/opening-file`,
      conversationId,
      name,
    }));
    getRunResourceLocalPathMock.mockResolvedValue('C:\\meeting-files\\opening.md');
    installFlowRuntime();
  });

  afterEach(async () => {
    for (const id of meetingIds.splice(0)) {
      meetingEventBus.clear(id);
      await deleteMeeting(id);
    }
  });

  it('runs one frozen barrier in parallel and commits speech in roster order', async () => {
    const meeting = await createMeeting(1);
    const completed = await meetingEngine.runToCompletion(meeting.id);
    const events = await readMeetingEvents(meeting.id);
    const speeches = events.filter((event) => event.type === 'participant:spoke');

    expect(completed.status).toBe('completed');
    expect(runFlowMock).toHaveBeenCalledTimes(2);
    expect(speeches.map((event) => event.participantId)).toEqual(['alpha', 'beta']);
    for (const [input] of runFlowMock.mock.calls) {
      expect(input).toMatchObject({
        source: 'meeting',
        userTurn: true,
        processNodeId: `${input.flowId}-start`,
      });
      expect(input.executionAuthority).toBeDefined();
      expect((input.messages as FlujoChatMessage[]).at(-1)?.role).toBe('user');
      expect(String((input.messages as FlujoChatMessage[]).at(-1)?.content)).toContain('Opening brief');
    }
  });

  it('delivers only committed peer speech as user context on the next round', async () => {
    const meeting = await createMeeting(2);
    await meetingEngine.runToCompletion(meeting.id);

    const secondRound = runFlowMock.mock.calls
      .map(([input]) => input)
      .filter((input) => input.meetingTurn?.roundId.endsWith('round-2'));
    expect(secondRound).toHaveLength(2);
    const alpha = secondRound.find((input) => input.meetingParticipant?.participantId === 'alpha')!;
    const beta = secondRound.find((input) => input.meetingParticipant?.participantId === 'beta')!;
    const alphaInbox = String((alpha.messages as FlujoChatMessage[]).at(-1)?.content);
    const betaInbox = String((beta.messages as FlujoChatMessage[]).at(-1)?.content);

    expect(alphaInbox).toContain('[Beta]');
    expect(alphaInbox).not.toContain('[Alpha]');
    expect(betaInbox).toContain('[Alpha]');
    expect(betaInbox).not.toContain('[Beta]');
    expect((alpha.messages as FlujoChatMessage[]).at(-1)?.role).toBe('user');
  });

  it('persists opening files into every participant conversation before the first turn', async () => {
    const meeting = await createMeeting(1);
    meeting.openingMedia = [{
      type: 'file',
      mimeType: 'text/markdown',
      name: 'opening.md',
      data: Buffer.from('# Opening evidence').toString('base64'),
    }];
    await saveMeeting(meeting);

    await meetingEngine.runToCompletion(meeting.id);

    expect(writeRunResourceMock).toHaveBeenCalledTimes(2);
    for (const [input] of runFlowMock.mock.calls) {
      const media = (input.messages as FlujoChatMessage[]).at(-1)?.media;
      expect(media).toEqual([expect.objectContaining({
        name: 'opening.md',
        resourceUri: `flujo://run/${input.conversationId}/opening-file`,
        data: undefined,
      })]);
    }
  });

  it('continues a completed meeting in the same participant conversations', async () => {
    const meeting = await createMeeting(1);
    const conversationIds = meeting.participants.map((participant) => participant.conversationId);
    await meetingEngine.runToCompletion(meeting.id);

    await meetingEngine.resume(meeting.id, 'Challenge the renderer decision.');
    const continued = await meetingEngine.runToCompletion(meeting.id);
    const events = await readMeetingEvents(meeting.id);

    expect(continued.id).toBe(meeting.id);
    expect(continued.participants.map((participant) => participant.conversationId)).toEqual(conversationIds);
    expect(runFlowMock).toHaveBeenCalledTimes(4);
    expect(events.filter((event) => event.type === 'meeting:completed')).toHaveLength(2);
    expect(events.some((event) =>
      event.type === 'meeting:resumed'
      && event.direction === 'Challenge the renderer decision.')).toBe(true);
    const continuedInputs = runFlowMock.mock.calls.slice(2).map(([input]) => input);
    for (const input of continuedInputs) {
      const latest = (input.messages as FlujoChatMessage[]).at(-1);
      expect(String(latest?.content)).toContain('Challenge the renderer decision.');
      expect(input.conversationId).toBe(conversationIds.find((id) => id === input.conversationId));
    }
  });

  it('aggregates matching finish proposals into an accepted majority motion', async () => {
    installFlowRuntime(() => [{ type: 'propose-motion', kind: 'finish', reason: 'Decision reached.' }]);
    const meeting = await createMeeting(4);
    const completed = await meetingEngine.runToCompletion(meeting.id);
    const events = await readMeetingEvents(meeting.id);

    expect(completed.roundNumber).toBe(1);
    expect(completed.motions).toHaveLength(1);
    expect(completed.motions[0]).toMatchObject({ kind: 'finish', status: 'accepted' });
    expect(completed.motions[0].votes.map((vote) => vote.participantId).sort()).toEqual(['alpha', 'beta']);
    expect(events.some((event) => event.type === 'motion:resolved' && event.outcome === 'accepted')).toBe(true);
  });

  it('reserves concurrent starts so only one barrier is launched', async () => {
    const meeting = await createMeeting(1);
    await Promise.all([meetingEngine.start(meeting.id), meetingEngine.start(meeting.id)]);
    await meetingEngine.runToCompletion(meeting.id);

    expect(runFlowMock).toHaveBeenCalledTimes(2);
  });

  it('serializes Flow-only starts across isolated process runtimes', async () => {
    const meeting = await createMeeting(1);
    let signalAdmitted!: () => void;
    let releaseAdmission!: () => void;
    const admitted = new Promise<void>((resolve) => { signalAdmitted = resolve; });
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const firstEngine = new MeetingEngine({
      isolateProcessRuntime: true,
      failpoints: {
        afterAdmissionBeforeRunningPersist: async () => {
          signalAdmitted();
          await admissionGate;
        },
      },
    });
    const secondEngine = new MeetingEngine({ isolateProcessRuntime: true });

    const firstStart = firstEngine.start(meeting.id);
    await admitted;
    const admittedRecord = await getMeeting(meeting.id);
    expect(admittedRecord).toMatchObject({
      status: 'draft',
      personaReservationGeneration: 1,
      personaReservationIntent: { generation: 1, state: 'reserving' },
    });

    const secondStart = await secondEngine.start(meeting.id);
    expect(secondStart.status).toBe('draft');
    expect(runFlowMock).not.toHaveBeenCalled();

    releaseAdmission();
    await firstStart;
    const completed = await firstEngine.runToCompletion(meeting.id);
    expect(completed.status).toBe('completed');
    expect(completed.personaReservationGeneration).toBe(1);
    expect(completed.personaReservationIntent).toBeUndefined();
    expect(runFlowMock).toHaveBeenCalledTimes(2);
  });

  it('never renews an already-expired meeting start intent', async () => {
    const meeting = await createMeeting(1);
    let signalAdmitted!: () => void;
    let releaseAdmission!: () => void;
    const admitted = new Promise<void>((resolve) => { signalAdmitted = resolve; });
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const engine = new MeetingEngine({
      isolateProcessRuntime: true,
      startIntentHeartbeatMs: 5,
      failpoints: {
        afterAdmissionBeforeRunningPersist: async () => {
          signalAdmitted();
          await admissionGate;
        },
      },
    });

    const startPromise = engine.start(meeting.id);
    await admitted;
    const admittedRecord = await getMeeting(meeting.id);
    const originalExpiry = admittedRecord!.personaReservationIntent!.expiresAt;
    expect(originalExpiry - admittedRecord!.personaReservationIntent!.createdAt)
      .toBe(MEETING_START_INTENT_TTL_MS);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(originalExpiry + 1);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const expired = await getMeeting(meeting.id);
      expect(expired?.personaReservationIntent?.expiresAt).toBe(originalExpiry);
      releaseAdmission();
      await expect(startPromise).rejects.toThrow('start intent was lost');
    } finally {
      nowSpy.mockRestore();
      releaseAdmission();
      await startPromise.catch(() => undefined);
    }
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('keeps cancellation terminal while in-flight participant calls unwind', async () => {
    const meeting = await createMeeting(2);
    const baseRun = runFlowMock.getMockImplementation()!;
    let startedCount = 0;
    let resolveStarted!: () => void;
    let releaseTurns!: () => void;
    const allStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const turnGate = new Promise<void>((resolve) => { releaseTurns = resolve; });
    runFlowMock.mockImplementation(async (input) => {
      startedCount += 1;
      if (startedCount === 2) resolveStarted();
      await turnGate;
      return baseRun(input);
    });

    await meetingEngine.start(meeting.id);
    await allStarted;
    const cancelled = await meetingEngine.cancel(meeting.id, 'Stop now.');
    expect(cancelled.status).toBe('cancelled');
    releaseTurns();

    for (let attempt = 0; attempt < 100 && meetingEngine.isRunning(meeting.id); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(meetingEngine.isRunning(meeting.id)).toBe(false);
    expect((await getMeeting(meeting.id))?.status).toBe('cancelled');
    const events = await readMeetingEvents(meeting.id);
    expect(events.at(-1)?.type).toBe('meeting:cancelled');
  });

  it('recovers a fully committed atomic round when its projection save was interrupted', async () => {
    const meeting = await createMeeting(2);
    const roundId = `${meeting.id}-round-1`;
    meeting.status = 'running';
    meeting.phase = 'discussion';
    meeting.roundNumber = 1;
    meeting.activeRound = {
      id: roundId,
      number: 1,
      phase: 'discussion',
      status: 'running',
      snapshotSeq: meeting.lastEventSeq,
      eligibleParticipantIds: ['alpha', 'beta'],
      participantTurnIds: {
        alpha: `${roundId}:alpha`,
        beta: `${roundId}:beta`,
      },
      startedAt: Date.now(),
    };
    for (const participant of meeting.participants) participant.status = 'running';
    await saveMeeting(meeting);
    await meetingEventBus.emitBatch(meeting.id, `${roundId}:commit`, [
      {
        type: 'participant:spoke',
        audience: 'public',
        roundId,
        participantId: 'alpha',
        participantName: 'Alpha',
        turnId: `${roundId}:alpha`,
        content: 'Recovered contribution.',
        eventId: `${roundId}:alpha:spoke`,
      },
      {
        type: 'round:completed',
        audience: 'public',
        roundId,
        roundNumber: 1,
        participantTurnIds: { ...meeting.activeRound.participantTurnIds },
        eventId: `${roundId}:completed`,
      },
    ]);

    const recovered = await meetingEngine.reconcileInterrupted(meeting.id);
    expect(recovered).toMatchObject({
      status: 'paused',
      activeRound: { id: roundId, status: 'completed' },
    });
    expect(recovered?.participants.map((participant) => participant.status))
      .toEqual(['idle', 'idle']);
  });

  it('fails closed when a durable round-start batch outran its projection snapshot', async () => {
    const meeting = await createMeeting(1);
    const roundId = `${meeting.id}-round-1`;
    const participantTurnIds = {
      alpha: `${roundId}:alpha`,
      beta: `${roundId}:beta`,
    };
    meeting.status = 'running';
    meeting.phase = 'discussion';
    meeting.startedAt = Date.now();
    await saveMeeting(meeting);
    await meetingEventBus.emitBatch(meeting.id, `${roundId}:start`, [
      {
        type: 'round:started',
        audience: 'public',
        roundId,
        round: {
          id: roundId,
          number: 1,
          phase: 'discussion',
          status: 'running',
          snapshotSeq: meeting.lastEventSeq,
          eligibleParticipantIds: ['alpha', 'beta'],
          participantTurnIds,
          startedAt: Date.now(),
        },
        eventId: `${roundId}:started`,
      },
      ...meeting.participants.map((participant) => ({
        type: 'participant:started' as const,
        audience: 'public' as const,
        roundId,
        participantId: participant.id,
        participantName: participant.name,
        turnId: participantTurnIds[participant.id as keyof typeof participantTurnIds],
        eventId: `${roundId}:${participant.id}:started`,
      })),
    ]);

    await expect(meetingEngine.start(meeting.id)).rejects.toThrow('durably started');

    expect(runFlowMock).not.toHaveBeenCalled();
    expect(await getMeeting(meeting.id)).toMatchObject({
      status: 'error',
      roundNumber: 1,
      activeRound: { id: roundId, status: 'error' },
    });
    const events = await readMeetingEvents(meeting.id);
    expect(events.filter((event) => event.type === 'round:started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'round:completed')).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('meeting:error');
  });

  it('projects a committed round before cancellation becomes terminal', async () => {
    const meeting = await createMeeting(2);
    const roundId = `${meeting.id}-round-1`;
    meeting.status = 'running';
    meeting.phase = 'discussion';
    meeting.roundNumber = 1;
    meeting.activeRound = {
      id: roundId,
      number: 1,
      phase: 'discussion',
      status: 'running',
      snapshotSeq: meeting.lastEventSeq,
      eligibleParticipantIds: ['alpha', 'beta'],
      participantTurnIds: {
        alpha: `${roundId}:alpha`,
        beta: `${roundId}:beta`,
      },
      startedAt: Date.now(),
    };
    for (const participant of meeting.participants) participant.status = 'running';
    await saveMeeting(meeting);
    await meetingEventBus.emitBatch(meeting.id, `${roundId}:commit`, [{
      type: 'round:completed',
      audience: 'public',
      roundId,
      roundNumber: 1,
      participantTurnIds: { ...meeting.activeRound.participantTurnIds },
      eventId: `${roundId}:completed`,
    }]);

    const cancelled = await meetingEngine.cancel(meeting.id, 'Cancel after recovery.');

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      activeRound: { id: roundId, status: 'completed' },
    });
    expect(cancelled.participants.map((participant) => participant.status))
      .toEqual(['idle', 'idle']);
  });

  it('repairs a terminal batch that outran its projection without emitting a conflicting terminal event', async () => {
    const meeting = await createMeeting(1);
    meeting.status = 'paused';
    meeting.phase = 'discussion';
    await saveMeeting(meeting);
    await meetingEventBus.emitBatch(meeting.id, `${meeting.id}:complete`, [{
      type: 'meeting:completed',
      audience: 'public',
      reason: 'Finished durably.',
      eventId: `${meeting.id}:completed`,
    }]);

    const recovered = await meetingEngine.reconcileInterrupted(meeting.id);
    expect(recovered?.status).toBe('completed');
    const events = await readMeetingEvents(meeting.id);
    expect(events.at(-1)?.type).toBe('meeting:completed');
    expect(events.filter((event) =>
      event.type === 'meeting:completed'
      || event.type === 'meeting:cancelled'
      || event.type === 'meeting:error')).toHaveLength(1);
  });

  it('does not emit an error when failure handling finds a durable terminal batch', async () => {
    const meeting = await createMeeting(1);
    meeting.status = 'running';
    meeting.phase = 'closing';
    await saveMeeting(meeting);
    await meetingEventBus.emitBatch(meeting.id, `${meeting.id}:complete`, [{
      type: 'meeting:completed',
      audience: 'public',
      reason: 'Terminal append won the crash race.',
      eventId: `${meeting.id}:completed`,
    }]);

    const recovered = await (
      meetingEngine as unknown as {
        failMeeting: (meetingId: string, error: unknown) => Promise<Awaited<typeof meeting>>;
      }
    ).failMeeting(meeting.id, new Error('projection save failed'));

    expect(recovered.status).toBe('completed');
    const events = await readMeetingEvents(meeting.id);
    expect(events.filter((event) =>
      event.type === 'meeting:completed'
      || event.type === 'meeting:cancelled'
      || event.type === 'meeting:error')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('meeting:completed');
  });

  it('keeps moderator bookends outside the discussion-round budget', async () => {
    const id = `meeting-${randomUUID()}`;
    meetingIds.push(id);
    const meeting = await meetingEngine.create({
      id,
      title: 'Moderated council',
      openingPrompt: 'Frame, discuss, and synthesize the architecture decision.',
      participants: [
        { id: 'alpha', name: 'Alpha', flowId: 'flow-alpha', conversationId: randomUUID(), role: 'moderator' },
        { id: 'beta', name: 'Beta', flowId: 'flow-beta', conversationId: randomUUID() },
      ],
      moderatorParticipantId: 'alpha',
      policy: { moderatorMode: 'bookends', maxRounds: 1, concurrencyLimit: 2 },
    });

    await meetingEngine.runToCompletion(meeting.id);
    const turns = runFlowMock.mock.calls.map(([input]) => ({
      participant: input.meetingParticipant?.participantId,
      roundId: input.meetingTurn?.roundId,
    }));
    expect(turns.map((turn) => turn.participant)).toEqual(['alpha', 'beta', 'alpha']);
    expect(turns[0].roundId).toContain('round-1');
    expect(turns[1].roundId).toContain('round-2');
    expect(turns[2].roundId).toContain('round-3');
  });
});
