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
  { params }: { params: { conversationId: string } }
) {
  const { conversationId } = params;
  if (!conversationId) {
    return new Response('Missing conversationId', { status: 400 });
  }

  const fromSeqParam = request.nextUrl.searchParams.get('fromSeq');
  const fromSeq = fromSeqParam !== null ? parseInt(fromSeqParam, 10) : null;

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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
          return;
        }
        // A run can pause (awaiting approval / debug) and resume on the same
        // conversation, so only a terminal run:done closes the stream.
        if (event.type === 'run:done') {
          cleanup();
        }
      };

      // Initial frame: reconnection hint + comment so proxies flush headers.
      controller.enqueue(encoder.encode(`retry: 3000\n\n: connected ${conversationId}\n\n`));

      // Replay buffered events first (ascending seq), then go live.
      if (fromSeq !== null && !Number.isNaN(fromSeq)) {
        for (const event of executionEventBus.getBufferedSince(conversationId, fromSeq)) {
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
