import { NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEngine } from '@/backend/execution/meeting';
import { readMeetingEvents } from '@/backend/services/meetings/eventLog';
import { saveMeeting } from '@/backend/services/meetings/store';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/meetings/[meetingId]/route');
export const dynamic = 'force-dynamic';

async function GET_handler(
  _request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const { meetingId } = await params;
  try {
    let meeting = await meetingEngine.reconcileInterrupted(meetingId);
    if (!meeting) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 });
    const events = await readMeetingEvents(meetingId);
    // The event append is intentionally durable before the projection save. A
    // GET racing that tiny window must not return `running` beside a terminal
    // event (the browser would then subscribe beyond the terminal cursor and
    // wait forever). Treat the latest lifecycle event as authoritative and
    // repair the snapshot when needed.
    const lifecycle = [...events].reverse().find((event) =>
      event.type === 'meeting:started'
      || event.type === 'meeting:completed'
      || event.type === 'meeting:cancelled'
      || event.type === 'meeting:error');
    if (
      lifecycle
      && lifecycle.type !== 'meeting:started'
      && meeting.lastEventSeq < lifecycle.seq
    ) {
      meeting.status = lifecycle.type === 'meeting:completed'
        ? 'completed'
        : lifecycle.type === 'meeting:cancelled'
          ? 'cancelled'
          : 'error';
      meeting.phase = 'completed';
      meeting.completedAt = lifecycle.timestamp;
      meeting.lastEventSeq = lifecycle.seq;
      if (lifecycle.type === 'meeting:error') meeting.error = lifecycle.error;
      for (const participant of meeting.participants) {
        if (participant.status === 'running') participant.status = 'idle';
      }
      meeting = await saveMeeting(meeting);
    }
    return NextResponse.json({ meeting, events });
  } catch (error) {
    log.error('Failed to load meeting', { meetingId, error });
    const invalid = error instanceof Error && /unsafe|invalid/i.test(error.message);
    return NextResponse.json(
      { error: invalid ? 'Invalid meeting id.' : 'Failed to load meeting.' },
      { status: invalid ? 400 : 500 },
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);
