import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEngine } from '@/backend/execution/meeting';
import { getMeeting, sanitizeMeetingForApi } from '@/backend/services/meetings/store';
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
    const stored = await getMeeting(meetingId);
    if (!stored) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 });
    if (stored.participants.some((participant) => participant.personaId)) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load meeting.';
    const status = /unsafe|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: status === 400 ? message : 'Failed to load meeting.' }, { status });
  }
  let reason: string | undefined;
  try {
    const body = await request.json() as { reason?: unknown };
    if (typeof body.reason === 'string' && body.reason.trim()) reason = body.reason.trim();
  } catch {
    // An empty request body is valid for cancellation.
  }
  try {
    const meeting = await meetingEngine.cancel(meetingId, reason);
    return NextResponse.json({ meeting: sanitizeMeetingForApi(meeting) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to cancel meeting.';
    const status = message.includes('not found') ? 404 : /unsafe|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
