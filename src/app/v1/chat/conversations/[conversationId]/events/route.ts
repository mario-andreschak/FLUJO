import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { ExecutionEvent } from '@/shared/types/execution/events';

const log = createLogger('app/v1/chat/conversations/[conversationId]/events/route');

// SSE must never be statically optimized or cached.
export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events stream of execution events for a conversation.
 *
 * Replaces the old polling-based streaming. Clients fetch the full conversation
 * once (GET /v1/chat/conversations/{id}) then attach here to receive live
 * events. Pass ?fromSeq=N to replay buffered events from a known position
 * after a reconnect (events carry a monotonic `seq`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  const { conversationId } = await params;
  if (!conversationId) {
    return new Response('Missing conversationId', { status: 400 });
  }

  // Replay position: explicit ?fromSeq= wins; otherwise honor the browser's
  // Last-Event-ID on auto-reconnect (resume just after the last seen event).
  const fromSeqParam = request.nextUrl.searchParams.get('fromSeq');
  const lastEventId = request.headers.get('last-event-id');
  let fromSeq: number | null = null;
  if (fromSeqParam !== null) {
    fromSeq = parseInt(fromSeqParam, 10);
  } else if (lastEventId !== null) {
    const parsed = parseInt(lastEventId, 10);
    if (!Number.isNaN(parsed)) fromSeq = parsed + 1;
  }

  log.info('Opening SSE event stream', { conversationId, fromSeq });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let maxSentSeq = -1;

  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const send = (event: ExecutionEvent) => {
        // Guard ordering/duplication: only forward strictly-newer events.
        if (event.seq <= maxSentSeq) return;
        maxSentSeq = event.seq;
        try {
          // `id:` lets the browser resume via Last-Event-ID after a drop.
          controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
          return;
        }
        // A run can pause (awaiting approval / debug) and resume on the same
        // conversation, so only a terminal run:done closes the stream — and
        // only the CHANNEL'S LATEST one. The buffer spans runs: a replay from
        // an early position on a continued conversation includes the previous
        // run's run:done, and closing on it would cut the stream off before
        // the live run's events are ever delivered.
        if (event.type === 'run:done' && event.seq + 1 >= executionEventBus.currentSeq(conversationId)) {
          cleanup();
        }
      };

      // Initial frame: reconnection hint + comment so proxies flush headers.
      controller.enqueue(encoder.encode(`retry: 3000\n\n: connected ${conversationId}\n\n`));

      // Replay buffered events first (ascending seq), then go live.
      if (fromSeq !== null && !Number.isNaN(fromSeq)) {
        const buffered = executionEventBus.getBufferedSince(conversationId, fromSeq);
        // The buffer spans runs on the same conversation (the channel — and its
        // monotonic seq — survives a run:done as long as the conversation is
        // continued). Replaying a FINISHED earlier run would feed the client
        // stale start/terminal transitions: its run:done tears down the live
        // view of the CURRENT run and (pre-guard) closed this stream before
        // the current run's events were ever delivered. So clamp the replay to
        // the latest run boundary; older history is served by the conversation
        // GET, not the live stream.
        let replayFrom = fromSeq;
        for (const event of buffered) {
          if (event.type === 'run:start') replayFrom = Math.max(replayFrom, event.seq);
        }
        for (const event of buffered) {
          if (event.seq < replayFrom) continue;
          send(event);
          if (closed) break;
        }
      }

      // A buffered run:done may have already closed the stream during replay.
      if (closed) return;

      unsubscribe = executionEventBus.subscribe(conversationId, send);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 15000);

      // Client disconnected.
      request.signal.addEventListener('abort', () => {
        log.debug('SSE client disconnected', { conversationId });
        cleanup();
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
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
