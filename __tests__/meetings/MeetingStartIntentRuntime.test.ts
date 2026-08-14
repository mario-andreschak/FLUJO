import { randomUUID } from 'crypto';

import type { FlowRunInput } from '@/backend/execution/flow/runFlow';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { Flow } from '@/shared/types/flow';

const runFlowMock = jest.fn();
const loadConversationStateMock = jest.fn();
const conversationStates = new Map<string, any>();

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...args: unknown[]) => runFlowMock(...args),
}));

jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: (...args: unknown[]) => loadConversationStateMock(...args),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map() },
}));

jest.mock('@/backend/services/runResources', () => ({
  copyRunResourceToConversation: jest.fn(),
  getRunResourceLocalPath: jest.fn(),
}));

import {
  MEETING_START_INTENT_TTL_MS,
  MeetingEngine,
} from '@/backend/execution/meeting/MeetingEngine';
import {
  getPersonaActivity,
  getPersonaLease,
  listPersonaMailboxItems,
} from '@/backend/services/enduringAgents';
import { createPersonaFromRole } from '../enduringAgents/fixtures/personaFactory';
import { resolvePersonaCoreRevision } from '@/backend/services/enduringAgents/personaCoreResolver';
import { flowService } from '@/backend/services/flow';
import { meetingEventBus } from '@/backend/services/meetings/MeetingEventBus';
import { deleteMeeting, getMeeting } from '@/backend/services/meetings/store';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => Promise<T>): Promise<T> {
  workspaceSequence += 1;
  return runWithWorkspace(
    `meeting-start-intent-${process.pid}-${workspaceSequence}`,
    task,
  );
}

function flow(id: string): Flow {
  return {
    id,
    name: id,
    nodes: [{
      id: `${id}_start`,
      type: 'start',
      position: { x: 0, y: 0 },
      data: { label: 'Start', type: 'start' },
    }],
    edges: [],
  };
}

describe('durable Persona meeting start intent', () => {
  beforeEach(() => {
    conversationStates.clear();
    runFlowMock.mockReset();
    loadConversationStateMock.mockReset().mockImplementation(
      async (conversationId: string) => conversationStates.get(conversationId),
    );
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
      conversationStates.set(input.conversationId!, sharedState);
      return {
        status: 'completed',
        conversationId: input.conversationId,
        runId: randomUUID(),
        outputText: assistant.content,
        messages,
        sharedState,
      };
    });
  });

  it('advances generation after a crash between Persona claims and the running snapshot', async () => {
    await inFreshWorkspace(async () => {
      await expect(flowService.saveFlow(flow('flow_legacy')))
        .resolves.toMatchObject({ success: true });
      const { persona } = await createPersonaFromRole({
        name: 'Crash-safe meeting participant',
        idempotencyKey: 'meeting-start-intent-persona',
        interruptionPolicy: 'queue',
      });
      await resolvePersonaCoreRevision(persona.id);
      const meetingId = 'meeting_start_crash';
      const crashingProcess = new MeetingEngine({
        isolateProcessRuntime: true,
        failpoints: {
          afterPersonaClaimsBeforeRunningPersist: () => {
            throw new Error('failpoint: process exited');
          },
        },
      });
      await crashingProcess.create({
        id: meetingId,
        title: 'Crash-safe council',
        openingPrompt: 'Finish after recovering the admission generation.',
        participants: [
          {
            id: 'living',
            name: 'Living',
            personaId: persona.id,
            behaviorSlotKey: 'primary',
            conversationId: 'conversation_living',
          },
          {
            id: 'legacy',
            name: 'Legacy',
            flowId: 'flow_legacy',
            conversationId: 'conversation_legacy',
          },
        ],
        policy: { maxRounds: 1, concurrencyLimit: 2, allSilentBehavior: 'finish' },
      });

      try {
        await expect(crashingProcess.start(meetingId)).rejects.toThrow(
          'Simulated meeting process crash',
        );
        const stranded = await getMeeting(meetingId);
        expect(stranded).toMatchObject({
          status: 'draft',
          personaReservationGeneration: 1,
          personaReservationIntent: { generation: 1, state: 'reserving' },
        });
        const firstItems = (await listPersonaMailboxItems(persona.id)).filter(
          (item) => item.payloadRef === `meeting:${meetingId}:living`,
        );
        expect(firstItems).toHaveLength(1);
        expect(firstItems[0].status).toBe('claimed');
        const firstActivity = await getPersonaActivity(firstItems[0].claimedActivityId!);
        const firstLease = await getPersonaLease(persona.id);
        expect(firstActivity?.status).toBe('running');
        expect(firstLease?.activityId).toBe(firstActivity?.id);

        const expiresAfter = Math.max(
          stranded!.personaReservationIntent!.expiresAt,
          firstLease!.expiresAt,
        );
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(
          expiresAfter + MEETING_START_INTENT_TTL_MS,
        );
        try {
          const restartedProcess = new MeetingEngine({ isolateProcessRuntime: true });
          const completed = await restartedProcess.runToCompletion(meetingId);

          expect(completed).toMatchObject({
            status: 'completed',
            personaReservationGeneration: 2,
          });
          expect(completed.personaReservationIntent).toBeUndefined();
          const allItems = (await listPersonaMailboxItems(persona.id)).filter(
            (item) => item.payloadRef === `meeting:${meetingId}:living`,
          );
          expect(allItems).toHaveLength(2);
          expect(new Set(allItems.map((item) => item.id)).size).toBe(2);
          expect(await getPersonaActivity(firstActivity!.id)).toMatchObject({ status: 'error' });
          const successor = allItems.find((item) => item.id !== firstItems[0].id)!;
          expect(await getPersonaActivity(successor.claimedActivityId!)).toMatchObject({
            status: 'completed',
            meetingId,
          });
        } finally {
          nowSpy.mockRestore();
        }
      } finally {
        meetingEventBus.clear(meetingId);
        await deleteMeeting(meetingId);
      }
    });
  });
});
