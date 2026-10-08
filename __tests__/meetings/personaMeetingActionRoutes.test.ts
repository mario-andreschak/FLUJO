const startMeetingMock = jest.fn();
const resumeMeetingMock = jest.fn();
const cancelMeetingMock = jest.fn();
const reconcileMeetingMock = jest.fn();
const getMeetingMock = jest.fn();
const saveMeetingMock = jest.fn();
const readMeetingEventsMock = jest.fn();
const subscribeMock = jest.fn();
const replaySinceMock = jest.fn();
const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/backend/execution/meeting', () => ({
  meetingEngine: {
    start: (...args: unknown[]) => startMeetingMock(...args),
    resume: (...args: unknown[]) => resumeMeetingMock(...args),
    cancel: (...args: unknown[]) => cancelMeetingMock(...args),
    reconcileInterrupted: (...args: unknown[]) => reconcileMeetingMock(...args),
  },
}));

jest.mock('@/backend/services/meetings/store', () => ({
  getMeeting: (...args: unknown[]) => getMeetingMock(...args),
  isPersonaScopedMeeting: (meeting: { participants?: Array<{
    personaId?: string;
    personaArchived?: boolean;
    personaRetired?: boolean;
  }> }) => meeting.participants?.some((participant) =>
    Boolean(participant.personaId || participant.personaArchived || participant.personaRetired)),
  saveMeeting: (...args: unknown[]) => saveMeetingMock(...args),
  sanitizeMeetingForApi: (meeting: Record<string, unknown>) => {
    const {
      personaReservationGeneration: _generation,
      personaReservationIntent: _intent,
      ...visible
    } = meeting;
    return visible;
  },
}));

jest.mock('@/backend/services/meetings/eventLog', () => ({
  readMeetingEvents: (...args: unknown[]) => readMeetingEventsMock(...args),
}));

jest.mock('@/backend/services/meetings/MeetingEventBus', () => ({
  meetingEventBus: {
    subscribe: (...args: unknown[]) => subscribeMock(...args),
    replaySince: (...args: unknown[]) => replaySinceMock(...args),
  },
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }),
}));

import { NextRequest } from 'next/server';
import { GET as getMeetingRoute } from '@/app/v1/meetings/[meetingId]/route';
import { POST as startMeetingRoute } from '@/app/v1/meetings/[meetingId]/start/route';
import { POST as resumeMeetingRoute } from '@/app/v1/meetings/[meetingId]/resume/route';
import { POST as cancelMeetingRoute } from '@/app/v1/meetings/[meetingId]/cancel/route';
import { GET as meetingEventsRoute } from '@/app/v1/meetings/[meetingId]/events/route';

const context = { params: Promise.resolve({ meetingId: 'meeting_1' }) };
const personaMeeting = {
  id: 'meeting_1',
  participants: [{ id: 'participant_1', personaId: 'persona_jim' }],
};
const legacyMeeting = {
  id: 'meeting_1',
  participants: [{ id: 'participant_1', flowId: 'flow_legacy' }],
};
const archivedPersonaMeeting = {
  id: 'meeting_1',
  participants: [{
    id: 'participant_1',
    name: 'Archived Persona participant',
    personaArchived: true,
    personaRetired: true,
  }],
};

describe('Persona meeting action routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(null);
    assertLocalRequestMock.mockReturnValue(null);
    getMeetingMock.mockResolvedValue(personaMeeting);
    startMeetingMock.mockResolvedValue(personaMeeting);
    resumeMeetingMock.mockResolvedValue(personaMeeting);
    cancelMeetingMock.mockResolvedValue(personaMeeting);
    reconcileMeetingMock.mockResolvedValue(personaMeeting);
    readMeetingEventsMock.mockResolvedValue([]);
    replaySinceMock.mockResolvedValue([]);
    subscribeMock.mockReturnValue(jest.fn());
  });

  it('guards Persona start, cancel, detail, and event access before lifecycle work', async () => {
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));

    const responses = await Promise.all([
      startMeetingRoute(new Request('http://localhost/v1/meetings/meeting_1/start', {
        method: 'POST',
      }), context),
      resumeMeetingRoute(new NextRequest('http://localhost/v1/meetings/meeting_1/resume', {
        method: 'POST',
      }), context),
      cancelMeetingRoute(new NextRequest('http://localhost/v1/meetings/meeting_1/cancel', {
        method: 'POST',
      }), context),
      getMeetingRoute(new Request('http://localhost/v1/meetings/meeting_1'), context),
      meetingEventsRoute(new NextRequest('http://localhost/v1/meetings/meeting_1/events'), context),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403, 403, 403]);
    expect(startMeetingMock).not.toHaveBeenCalled();
    expect(resumeMeetingMock).not.toHaveBeenCalled();
    expect(cancelMeetingMock).not.toHaveBeenCalled();
    expect(reconcileMeetingMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('keeps archived Persona meetings local-only after their Persona id is erased', async () => {
    getMeetingMock.mockResolvedValue(archivedPersonaMeeting);
    reconcileMeetingMock.mockResolvedValue(archivedPersonaMeeting);
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));

    const responses = await Promise.all([
      startMeetingRoute(new Request('http://localhost/v1/meetings/meeting_1/start', {
        method: 'POST',
      }), context),
      resumeMeetingRoute(new NextRequest('http://localhost/v1/meetings/meeting_1/resume', {
        method: 'POST',
      }), context),
      cancelMeetingRoute(new NextRequest('http://localhost/v1/meetings/meeting_1/cancel', {
        method: 'POST',
      }), context),
      getMeetingRoute(new Request('http://localhost/v1/meetings/meeting_1'), context),
      meetingEventsRoute(new NextRequest('http://localhost/v1/meetings/meeting_1/events'), context),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403, 403, 403]);
    expect(startMeetingMock).not.toHaveBeenCalled();
    expect(resumeMeetingMock).not.toHaveBeenCalled();
    expect(cancelMeetingMock).not.toHaveBeenCalled();
    expect(reconcileMeetingMock).not.toHaveBeenCalled();
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('preserves Flow-only start and cancel without invoking the Persona guard', async () => {
    getMeetingMock.mockResolvedValue(legacyMeeting);
    startMeetingMock.mockResolvedValue(legacyMeeting);
    cancelMeetingMock.mockResolvedValue(legacyMeeting);
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));

    const started = await startMeetingRoute(
      new Request('http://localhost/v1/meetings/meeting_1/start', { method: 'POST' }),
      context,
    );
    const cancelled = await cancelMeetingRoute(
      new NextRequest('http://localhost/v1/meetings/meeting_1/cancel', { method: 'POST' }),
      context,
    );
    const resumed = await resumeMeetingRoute(
      new NextRequest('http://localhost/v1/meetings/meeting_1/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'Revisit the render decision.' }),
      }),
      context,
    );

    expect(started.status).toBe(200);
    expect(cancelled.status).toBe(200);
    expect(resumed.status).toBe(200);
    expect(assertLocalRequestMock).not.toHaveBeenCalled();
    expect(startMeetingMock).toHaveBeenCalledWith('meeting_1');
    expect(resumeMeetingMock).toHaveBeenCalledWith('meeting_1', 'Revisit the render decision.');
    expect(cancelMeetingMock).toHaveBeenCalledWith('meeting_1', undefined);
  });

  it('never exposes the internal Persona start owner or reservation attempt', async () => {
    const internal = {
      ...personaMeeting,
      personaReservationGeneration: 7,
      personaReservationIntent: {
        generation: 7,
        attemptId: 'secret_attempt',
        ownerId: 'secret_owner',
        state: 'running',
        createdAt: 1,
        updatedAt: 2,
        expiresAt: 30_002,
      },
    };
    getMeetingMock.mockResolvedValue(internal);
    startMeetingMock.mockResolvedValue(internal);
    reconcileMeetingMock.mockResolvedValue(internal);

    const started = await startMeetingRoute(
      new Request('http://localhost/v1/meetings/meeting_1/start', { method: 'POST' }),
      context,
    );
    const detail = await getMeetingRoute(
      new Request('http://localhost/v1/meetings/meeting_1'),
      context,
    );
    const payload = JSON.stringify([await started.json(), await detail.json()]);

    expect(payload).not.toContain('secret_owner');
    expect(payload).not.toContain('secret_attempt');
    expect(payload).not.toContain('personaReservationIntent');
    expect(payload).not.toContain('personaReservationGeneration');
  });
});
