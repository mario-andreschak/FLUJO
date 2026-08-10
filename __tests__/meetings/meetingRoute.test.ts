const createMeetingMock = jest.fn();
const listMeetingsMock = jest.fn();
const summarizeMeetingMock = jest.fn((meeting: unknown) => meeting);
const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/backend/execution/meeting', () => ({
  meetingEngine: { create: (...args: unknown[]) => createMeetingMock(...args) },
}));

jest.mock('@/backend/services/meetings/store', () => ({
  isPersonaScopedMeeting: (meeting: { participants?: Array<{
    personaId?: string;
    personaArchived?: boolean;
    personaRetired?: boolean;
  }> }) => meeting.participants?.some((participant) =>
    Boolean(participant.personaId || participant.personaArchived || participant.personaRetired)),
  listMeetings: (...args: unknown[]) => listMeetingsMock(...args),
  summarizeMeeting: (meeting: unknown) => summarizeMeetingMock(meeting),
  sanitizeMeetingForApi: (meeting: Record<string, unknown>) => {
    const {
      personaReservationGeneration: _generation,
      personaReservationIntent: _intent,
      ...visible
    } = meeting;
    return visible;
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
import { GET, POST } from '@/app/v1/meetings/route';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/v1/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/meetings Persona targeting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(null);
    assertLocalRequestMock.mockReturnValue(null);
    createMeetingMock.mockResolvedValue({ id: 'meeting_1', status: 'draft' });
    listMeetingsMock.mockResolvedValue([]);
  });

  it('requires a local request before accepting a Persona participant', async () => {
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));

    const response = await POST(request({
      title: 'Persona meeting',
      participants: [{ name: 'Jim', personaId: 'persona_jim' }],
    }));

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledTimes(1);
    expect(createMeetingMock).not.toHaveBeenCalled();
  });

  it('allows a local Persona participant through to MeetingEngine validation', async () => {
    const input = {
      title: 'Persona meeting',
      participants: [{ name: 'Jim', personaId: 'persona_jim' }],
    };

    const response = await POST(request(input));

    expect(response.status).toBe(201);
    expect(createMeetingMock).toHaveBeenCalledWith(input);
  });

  it('preserves the remotely compatible Flow-only meeting path', async () => {
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
    const input = {
      title: 'Legacy meeting',
      participants: [{ name: 'Legacy', flowId: 'flow_legacy' }],
    };

    const response = await POST(request(input));

    expect(response.status).toBe(201);
    expect(assertLocalRequestMock).not.toHaveBeenCalled();
    expect(createMeetingMock).toHaveBeenCalledWith(input);
  });

  it('filters Persona meetings from remote summaries while preserving legacy meetings', async () => {
    listMeetingsMock.mockResolvedValue([
      { id: 'legacy', participants: [{ flowId: 'flow_legacy' }] },
      { id: 'persona', participants: [{ personaId: 'persona_jim' }] },
      {
        id: 'archived-persona',
        participants: [{ personaArchived: true, personaRetired: true }],
      },
    ]);
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
    const req = new NextRequest('https://flujo.example.com/v1/meetings');

    const response = await GET(req);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 'legacy', participants: [{ flowId: 'flow_legacy' }] }]);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(req, { strictLoopback: true });
  });
});
