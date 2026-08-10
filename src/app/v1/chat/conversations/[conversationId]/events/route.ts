import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { readConversationLog } from '@/backend/execution/flow/conversationLog';
import { ExecutionEvent } from '@/shared/types/execution/events';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { assertLocalRequest } from '@/utils/http/localRequest';

const log = createLogger('app/v1/chat/conversations/[conversationId]/events/route');

// SSE must never be statically optimized or cached.
export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events stream of execution events for a conversation.
 *
 * Replaces the old polling-based streaming. Clients fetch the full conversation
 * once (GET /v1/chat/conversations/{id}) then attach here to receive live
 * events. Pass ?fromSeq=N to resume from a known position after a reconnect:
 * events carry an authoritative, durable, monotonic per-conversation `seq`
 * (issue #261). Recent positions are served from the in-memory ring buffer;
 * positions older than the buffer (evicted, channel GC'd, or after a process
 * restart) are replayed from the durable JSONL log.
 */
async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  const { conversationId } = await params;
  if (!conversationId) {
    return new Response('Missing conversationId', { status: 400 });
  }

  const state = await loadConversationState(conversationId);
  // Missing state cannot prove that an orphaned event channel is legacy.
  // Persona-owned and ownership-unknown streams are local control-plane only.
  if (!state || state.personaAttribution) {
    const notLocal = assertLocalRequest(request, { strictLoopback: true });
    if (notLocal) return notLocal;
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
    async start(controller) {
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

      // Replay from the cursor (ascending seq), then go live. Recent positions
      // are served from the in-memory ring buffer; when the requested position
      // is older than the buffer holds (evicted, channel GC'd, or after a
      // process restart) we fall back to the durable JSONL log for the gap.
      // seq is authoritative and monotonic (issue #261), so the two sources
      // share one sequence space and `send`'s strictly-newer guard dedups any
      // overlap. readConversationLog is awaited BEFORE the buffer snapshot so
      // events emitted during the read land in the buffer and are still caught;
      // there is no await between the buffer snapshot and subscribe, so no live
      // event can slip through the gap.
      if (fromSeq !== null && !Number.isNaN(fromSeq)) {
        const logged = await readConversationLog(conversationId);
        const buffered = executionEventBus.getBufferedSince(conversationId, fromSeq);
        const earliestBuffered = buffered.length ? buffered[0].seq : Number.POSITIVE_INFINITY;

        const replay: ExecutionEvent[] = [];
        // JSONL fills only the [fromSeq, earliestBuffered) gap the buffer can't
        // cover. Only persisted event types live in the log; transient liveness
        // events (model deltas, tool progress) are intentionally not replayed.
        if (logged && (buffered.length === 0 || earliestBuffered > fromSeq)) {
          for (const event of logged) {
            if (event.seq >= fromSeq && event.seq < earliestBuffered) replay.push(event);
          }
        }
        for (const event of buffered) replay.push(event);

        // Clamp to the latest run boundary. Replaying a FINISHED earlier run
        // would feed the client stale start/terminal transitions: its run:done
        // tears down the live view of the CURRENT run and (pre-guard) closed
        // this stream before the current run's events were delivered. Older
        // history is served by the conversation GET, not the live stream.
        let replayFrom = fromSeq;
        for (const event of replay) {
          if (event.type === 'run:start') replayFrom = Math.max(replayFrom, event.seq);
        }
        for (const event of replay) {
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

export const GET = withWorkspaceRoute(GET_handler);
