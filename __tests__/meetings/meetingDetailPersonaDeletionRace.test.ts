const reconcileInterruptedMock = jest.fn();
const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/backend/execution/meeting', () => ({
  meetingEngine: {
    reconcileInterrupted: (...args: unknown[]) => reconcileInterruptedMock(...args),
  },
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

import { GET } from '@/app/v1/meetings/[meetingId]/route';
import {
  anonymizeMeetingPersonaAttribution,
  createMeetingRecord,
  getMeeting,
  saveMeeting,
} from '@/backend/services/meetings/store';
import {
  appendMeetingEvent,
  readMeetingEvents,
} from '@/backend/services/meetings/eventLog';
import { ARCHIVED_MEETING_PARTICIPANT_NAME } from '@/shared/types/meeting';
import { ensureWorkspaceDirs, runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function freshWorkspace(): string {
  workspaceSequence += 1;
  return `meeting-detail-race-${process.pid}-${workspaceSequence}`;
}

describe('GET /v1/meetings/:meetingId Persona deletion serialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(null);
    assertLocalRequestMock.mockReturnValue(null);
  });

  it('cannot restore identifying participant data from a stale terminal projection', async () => {
    const workspace = freshWorkspace();
    await ensureWorkspaceDirs(workspace);
    const meetingId = 'meeting_get_delete_race';
    const personaId = 'persona_get_delete_race';
    await runWithWorkspace(workspace, async () => {
      const meeting = createMeetingRecord({
        id: meetingId,
        title: 'Terminal projection race',
        openingPrompt: 'Preserve the transcript but erase Persona attribution.',
        participants: [
          {
            id: 'persona-participant',
            name: 'Private Persona Name',
            personaId,
            behaviorSlotKey: 'primary',
          },
          {
            id: 'legacy-participant',
            name: 'Legacy Flow',
            flowId: 'flow_legacy',
          },
        ],
      });
      meeting.status = 'running';
      meeting.phase = 'discussion';
      meeting.participants[0].behaviorRevisionId = 'revision_get_delete_race';
      meeting.participants[0].activityId = 'activity_get_delete_race';
      meeting.participants[0].status = 'running';
      meeting.participants[1].status = 'running';
      await saveMeeting(meeting);
      await appendMeetingEvent(meetingId, {
        type: 'participant:spoke',
        audience: 'public',
        participantId: 'persona-participant',
        participantName: 'Private Persona Name',
        turnId: 'turn-private',
        content: 'Retained meeting content.',
        eventId: 'turn-private:spoke',
      });
      await appendMeetingEvent(meetingId, {
        type: 'meeting:completed',
        audience: 'public',
        reason: 'Finished durably before projection save.',
        eventId: `${meetingId}:completed`,
      });
    });

    let capturedStaleRead!: () => void;
    let releaseReconcile!: () => void;
    const staleRead = new Promise<void>((resolve) => { capturedStaleRead = resolve; });
    const reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    reconcileInterruptedMock.mockImplementation(async () => {
      const stale = await getMeeting(meetingId);
      capturedStaleRead();
      await reconcileGate;
      return stale;
    });

    const request = new Request(
      `http://localhost/v1/meetings/${meetingId}?workspace=${workspace}`,
    );
    const responsePromise = GET(request, {
      params: Promise.resolve({ meetingId }),
    });
    await staleRead;
    await runWithWorkspace(workspace, () => anonymizeMeetingPersonaAttribution(personaId));
    releaseReconcile();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.meeting).toMatchObject({ status: 'completed', phase: 'completed' });
    expect(JSON.stringify(payload)).not.toContain(personaId);
    expect(JSON.stringify(payload)).not.toContain('Private Persona Name');

    await runWithWorkspace(workspace, async () => {
      const persisted = await getMeeting(meetingId);
      expect(persisted).toMatchObject({ status: 'completed', phase: 'completed' });
      expect(persisted?.participants[0]).toEqual(expect.objectContaining({
        id: 'persona-participant',
        name: ARCHIVED_MEETING_PARTICIPANT_NAME,
        personaArchived: true,
        personaRetired: true,
        status: 'left',
      }));
      expect(persisted?.participants[0]).not.toHaveProperty('personaId');
      expect(persisted?.participants[0]).not.toHaveProperty('activityId');
      expect(persisted?.participants[0]).not.toHaveProperty('behaviorRevisionId');
      expect(await readMeetingEvents(meetingId)).toEqual([
        expect.objectContaining({
          type: 'participant:spoke',
          participantId: 'persona-participant',
          participantName: ARCHIVED_MEETING_PARTICIPANT_NAME,
        }),
        expect.objectContaining({ type: 'meeting:completed' }),
      ]);
    });
    // The optimistic live Persona and the authoritative archived marker both
    // require the strict local-only boundary.
    expect(assertLocalRequestMock).toHaveBeenCalledTimes(2);
    expect(assertLocalRequestMock).toHaveBeenNthCalledWith(
      2,
      request,
      { strictLoopback: true },
    );
  });
});
