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
    if (!(await getMeeting(meetingId))) {
      return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 });
    }
    const body = await request.json() as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content || content.length > 12_000) {
      return NextResponse.json({ error: 'Private note must contain between 1 and 12,000 characters.' }, { status: 400 });
    }
    const event = await meetingEventBus.emit(meetingId, {
      type: 'private-note',
      audience: [],
      content,
      eventId: `${meetingId}:private-note:${randomUUID()}`,
    });
    return NextResponse.json({ event }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not save private note.';
    const status = /unsafe|invalid json/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: status === 400 ? message : 'Could not save private note.' }, { status });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
