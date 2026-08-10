import { NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEngine } from '@/backend/execution/meeting';
import { readMeetingEvents } from '@/backend/services/meetings/eventLog';
import {
  getMeeting,
  isPersonaScopedMeeting,
  sanitizeMeetingForApi,
  saveMeeting,
} from '@/backend/services/meetings/store';
import { withMeetingControlLock } from '@/backend/services/meetings/controlLock';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/meetings/[meetingId]/route');
export const dynamic = 'force-dynamic';

async function GET_handler(
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
    if (!await meetingEngine.reconcileInterrupted(meetingId)) {
      return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 });
    }
    const detail = await withMeetingControlLock(meetingId, async () => {
      // Re-read only after acquiring the same lock used by Persona retirement
      // and anonymization. A reconciliation result obtained before deletion is
      // never allowed to overwrite the authoritative scrubbed snapshot.
      let meeting = await getMeeting(meetingId);
      if (!meeting) return null;
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
      return { meeting, events };
    });
    if (!detail) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 });
    // Recheck the authoritative marker as well as the optimistic pre-reconcile
    // snapshot. This preserves the strict boundary if a legacy record is
    // repaired or retired while the request is in progress.
    if (isPersonaScopedMeeting(detail.meeting)) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }
    return NextResponse.json({
      meeting: sanitizeMeetingForApi(detail.meeting),
      events: detail.events,
    });
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
