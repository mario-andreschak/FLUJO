import { NextRequest, NextResponse } from 'next/server';

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
  request: NextRequest,
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

    let direction: string | undefined;
    try {
      const body = await request.json() as { direction?: unknown };
      if (typeof body.direction === 'string' && body.direction.trim()) {
        direction = body.direction.trim();
      }
    } catch {
      // An empty body is valid for a directionless continuation.
    }
    if (direction && direction.length > 12_000) {
      return NextResponse.json(
        { error: 'Continuation prompt must be at most 12,000 characters.' },
        { status: 400 },
      );
    }

    const meeting = await meetingEngine.resume(meetingId, direction);
    return NextResponse.json({ meeting: sanitizeMeetingForApi(meeting) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to continue meeting.';
    const status = message.includes('not found')
      ? 404
      : /not finished|no participants|already/i.test(message)
        ? 409
        : /unsafe|invalid/i.test(message)
          ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
