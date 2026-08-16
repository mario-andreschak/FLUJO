import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEngine } from '@/backend/execution/meeting';
import { getMeeting, isPersonaScopedMeeting } from '@/backend/services/meetings/store';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

export const dynamic = 'force-dynamic';

async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const { meetingId } = await params;
  try {
    const meeting = await getMeeting(meetingId);
    if (!meeting) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 });
    if (isPersonaScopedMeeting(meeting)) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
    const body = await request.json() as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content || content.length > 12_000) {
      return NextResponse.json({ error: 'Participant message must contain between 1 and 12,000 characters.' }, { status: 400 });
    }
    const event = await meetingEngine.messageParticipants(meetingId, content);
    return NextResponse.json({ event }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not message meeting participants.';
    const status = /not found/i.test(message)
      ? 404
      : /only a live meeting/i.test(message)
        ? 409
        : /unsafe|invalid json|must contain/i.test(message)
          ? 400
          : 500;
    return NextResponse.json({
      error: status === 500 ? 'Could not message meeting participants.' : message,
    }, { status });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
