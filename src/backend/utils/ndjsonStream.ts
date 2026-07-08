import { createLogger } from '@/utils/logger';
import { CommandStreamEvent } from '@/shared/types/streaming';
import { encodeNdjsonLine } from '@/shared/utils/ndjson';

const log = createLogger('backend/utils/ndjsonStream');

/**
 * Shared NDJSON streaming plumbing for FLUJO's server-side command streams (issues #64,
 * #65). Wraps a producer that emits {@link CommandStreamEvent}s into a `Response` whose
 * body is a `ReadableStream` of NDJSON lines, so the browser can render stdout/stderr
 * and lifecycle markers live instead of waiting for one final blob.
 *
 * Ownership rules:
 *  - The producer receives an `emit()` it may call any number of times, plus the
 *    request's `AbortSignal` so it can stop work when the client navigates away.
 *  - `emit()` after the stream has closed is a safe no-op (guards enqueue-after-close).
 *  - When the producer's promise settles, the stream is closed. If it rejects, a final
 *    `{ type:'result', success:false }` is emitted so the consumer always terminates.
 */

const NDJSON_HEADERS: HeadersInit = {
  // application/x-ndjson: one JSON object per line.
  'Content-Type': 'application/x-ndjson',
  // Never cache a live probe/build stream.
  'Cache-Control': 'no-store',
  // Ask intermediary proxies (nginx) not to buffer, so lines arrive incrementally.
  'X-Accel-Buffering': 'no',
};

export function createNdjsonStreamResponse(
  producer: (emit: (event: CommandStreamEvent) => void, signal: AbortSignal) => Promise<void>,
  options?: { signal?: AbortSignal }
): Response {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  // Chain the request's signal (if any) into our internal one.
  if (options?.signal) {
    if (options.signal.aborted) abortController.abort();
    else options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const emit = (event: CommandStreamEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeNdjsonLine(event)));
        } catch (err) {
          // Controller already closed (client aborted mid-write) — stop emitting.
          closed = true;
          log.debug(`enqueue after close ignored: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      try {
        await producer(emit, abortController.signal);
      } catch (err) {
        log.warn('NDJSON producer threw; emitting terminal error result', err);
        emit({
          type: 'result',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed — nothing to do.
        }
      }
    },
    cancel() {
      // Client disconnected / aborted the fetch — let the producer clean up.
      abortController.abort();
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });
}
