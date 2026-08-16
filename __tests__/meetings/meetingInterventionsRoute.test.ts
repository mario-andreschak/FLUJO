const messageParticipantsMock = jest.fn();
const assertUnlockedMock = jest.fn();
const getMeetingMock = jest.fn();
const assertLocalRequestMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T,>(handler: T) => handler,
}));

jest.mock('@/backend/execution/meeting', () => ({
  meetingEngine: {
    messageParticipants: (...args: unknown[]) => messageParticipantsMock(...args),
  },
}));

jest.mock('@/backend/services/meetings/store', () => ({
  getMeeting: (...args: unknown[]) => getMeetingMock(...args),
  isPersonaScopedMeeting: (meeting: { participants?: Array<{ personaId?: string }> }) =>
    meeting.participants?.some((participant) => Boolean(participant.personaId)),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/v1/meetings/[meetingId]/interventions/route';

const context = { params: Promise.resolve({ meetingId: 'meeting_1' }) };

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/v1/meetings/meeting_1/interventions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/meetings/:meetingId/interventions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(null);
    assertLocalRequestMock.mockReturnValue(null);
    getMeetingMock.mockResolvedValue({
      id: 'meeting_1',
      participants: [{ id: 'participant_1', flowId: 'flow_1' }],
    });
    messageParticipantsMock.mockResolvedValue({
      type: 'moderator:intervention',
      eventId: 'meeting_1:intervention:1',
      content: 'Compare the two launch dates.',
    });
  });

  it('sends the submitted text through the participant-message engine path', async () => {
    const response = await POST(request({
      content: '  Compare the two launch dates.  ',
    }), context);

    expect(response.status).toBe(202);
    expect(messageParticipantsMock).toHaveBeenCalledWith(
      'meeting_1',
      'Compare the two launch dates.',
    );
    await expect(response.json()).resolves.toEqual({
      event: expect.objectContaining({
        type: 'moderator:intervention',
        content: 'Compare the two launch dates.',
      }),
    });
  });

  it('preserves a conflict response when the meeting is no longer live', async () => {
    messageParticipantsMock.mockRejectedValue(new Error('Only a live meeting can be messaged.'));

    const response = await POST(request({ content: 'Too late.' }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Only a live meeting can be messaged.',
    });
  });

  it('keeps Persona participant messaging on the local control plane', async () => {
    getMeetingMock.mockResolvedValue({
      id: 'meeting_1',
      participants: [{ id: 'participant_1', personaId: 'persona_1' }],
    });
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));

    const response = await POST(request({ content: 'Do not deliver remotely.' }), context);

    expect(response.status).toBe(403);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(expect.any(NextRequest), {
      strictLoopback: true,
    });
    expect(messageParticipantsMock).not.toHaveBeenCalled();
  });
});
