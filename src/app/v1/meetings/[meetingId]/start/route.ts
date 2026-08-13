import { NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEngine } from '@/backend/execution/meeting';
import {
  getMeeting,
  isPersonaScopedMeeting,
  sanitizeMeetingForApi,
} from '@/backend/services/meetings/store';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

export const dynamic = 'force-dynamic';

async function POST_handler(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const { meetingId } = await params;
  try {
    const stored = await getMeeting(meetingId);
    if (!stored) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 });
    if (isPersonaScopedMeeting(stored)) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
    const meeting = await meetingEngine.start(meetingId);
    return NextResponse.json({ meeting: sanitizeMeetingForApi(meeting) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start meeting.';
    const status = message.includes('not found') ? 404 : message.includes('already') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
