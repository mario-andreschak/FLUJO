import { NextRequest } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEventBus } from '@/backend/services/meetings/MeetingEventBus';
import { getMeeting } from '@/backend/services/meetings/store';
import type { MeetingEvent } from '@/shared/types/meeting';
import { assertUnlocked } from '@/utils/encryption/lockGate';

export const dynamic = 'force-dynamic';

function isTerminal(event: MeetingEvent): boolean {
  return event.type === 'meeting:completed'
    || event.type === 'meeting:cancelled'
    || event.type === 'meeting:error';
}

async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const { meetingId } = await params;
  try {
    if (!(await getMeeting(meetingId))) return new Response('Meeting not found', { status: 404 });
  } catch (error) {
    const invalid = error instanceof Error && /unsafe|invalid/i.test(error.message);
    return new Response(invalid ? 'Invalid meeting id' : 'Failed to load meeting', {
      status: invalid ? 400 : 500,
    });
  }

  const fromParam = request.nextUrl.searchParams.get('fromSeq');
  const lastEventId = request.headers.get('last-event-id');
  const queryCursor = Number.parseInt(fromParam ?? '0', 10);
  const reconnectCursor = Number.parseInt(lastEventId ?? '-1', 10) + 1;
  const fromSeq = Math.max(
    0,
    Number.isSafeInteger(queryCursor) ? queryCursor : 0,
    Number.isSafeInteger(reconnectCursor) ? reconnectCursor : 0,
  );
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let replaying = true;
  const queuedLive: MeetingEvent[] = [];
  let maxSentSeq = fromSeq - 1;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (event: MeetingEvent) => {
        if (closed || event.seq <= maxSentSeq) return;
        maxSentSeq = event.seq;
        try {
          controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
          return;
        }
        if (isTerminal(event)) cleanup();
      };
      const onLive = (event: MeetingEvent) => {
        if (replaying) queuedLive.push(event);
        else send(event);
      };

      controller.enqueue(encoder.encode(`retry: 3000\n\n: connected ${meetingId}\n\n`));
      // Subscribe before replay so no event can fall into the await gap. The
      // strict sequence guard removes overlap between durable replay and the
      // small live queue accumulated while it was read.
      unsubscribe = meetingEventBus.subscribe(meetingId, onLive);
      try {
        for (const event of await meetingEventBus.replaySince(meetingId, fromSeq)) {
          send(event);
          if (closed) return;
        }
        replaying = false;
        queuedLive.sort((left, right) => left.seq - right.seq).forEach(send);
        if (closed) return;
      } catch {
        cleanup();
        return;
      }

      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { cleanup(); }
      }, 15_000);
      request.signal.addEventListener('abort', cleanup, { once: true });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export const GET = withWorkspaceRoute(GET_handler);
