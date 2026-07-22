import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { executionEventBus, GlobalEvent } from '@/backend/execution/flow/engine/ExecutionEventBus';

const log = createLogger('app/v1/chat/events/route');

// SSE must never be statically optimized or cached.
export const dynamic = 'force-dynamic';

/**
 * Global firehose: a single Server-Sent Events stream of execution events
 * across ALL conversations. Lets a client (e.g. the brain viz) watch every
 * running flow and subflow over ONE connection, instead of opening one
 * EventSource per conversation — which hits the browser's ~6-per-origin
 * connection cap the moment several subflows fan out in parallel.
 *
 * Additive to the per-conversation stream
 * (/v1/chat/conversations/{id}/events), which chat still uses unchanged. Each
 * frame's `data` is the same event shape as that stream (already carrying
 * `conversationId`, `flowId`, `depth`, lane fields, …); the SSE `id` is a
 * process-global sequence so ?fromSeq= / Last-Event-ID can resume after a drop
 * without tracking per-conversation seqs.
 *
 * Unlike the per-conversation stream this NEVER closes on a `run:done` — it
 * spans every conversation, so a single run finishing must not tear it down.
 * It ends only when the client disconnects.
 */
export async function GET(request: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

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

  log.info('Opening global SSE firehose', { fromSeq });

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

      const send = ({ globalSeq, event }: GlobalEvent) => {
        // Guard ordering/duplication: only forward strictly-newer entries.
        if (globalSeq <= maxSentSeq) return;
        maxSentSeq = globalSeq;
        try {
          // `id:` (the global seq) lets the browser resume via Last-Event-ID.
          controller.enqueue(encoder.encode(`id: ${globalSeq}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
        // Deliberately NO run:done teardown — the firehose spans all
        // conversations and outlives any single run.
      };

      // Initial frame: reconnection hint + comment so proxies flush headers.
      controller.enqueue(encoder.encode(`retry: 3000\n\n: connected firehose\n\n`));

      // Replay buffered entries first (ascending globalSeq), then go live.
      if (fromSeq !== null && !Number.isNaN(fromSeq)) {
        for (const entry of executionEventBus.getGlobalBufferedSince(fromSeq)) {
          send(entry);
          if (closed) break;
        }
      }
      if (closed) return;

      unsubscribe = executionEventBus.subscribeGlobal(send);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 15000);

      // Client disconnected.
      request.signal.addEventListener('abort', () => {
        log.debug('Global SSE firehose client disconnected');
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
