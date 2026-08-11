import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEventBus } from '@/backend/services/meetings/MeetingEventBus';
import { getMeeting } from '@/backend/services/meetings/store';
import { assertUnlocked } from '@/utils/encryption/lockGate';

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
    if (meeting.status !== 'running') {
      return NextResponse.json({ error: 'Only a live meeting can be steered.' }, { status: 409 });
    }
    const body = await request.json() as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content || content.length > 12_000) {
      return NextResponse.json({ error: 'Steering prompt must contain between 1 and 12,000 characters.' }, { status: 400 });
    }
    const event = await meetingEventBus.emit(meetingId, {
      type: 'moderator:intervention',
      audience: 'public',
      content,
      eventId: `${meetingId}:intervention:${randomUUID()}`,
    });
    return NextResponse.json({ event }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not steer meeting.';
    const status = /unsafe|invalid json/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: status === 400 ? message : 'Could not steer meeting.' }, { status });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
