import { createLogger } from '@/utils/logger';
import { encodeNdjsonLine } from '@/shared/utils/ndjson';

const log = createLogger('backend/utils/jsonEventStream');

const STREAM_HEADERS: HeadersInit = {
  'Content-Type': 'application/x-ndjson',
  'Cache-Control': 'no-store',
  'X-Accel-Buffering': 'no',
};

/** Generic NDJSON response for typed, one-shot application event streams. */
export function createJsonEventStreamResponse<T extends object>(
  producer: (emit: (event: T) => void, signal: AbortSignal) => Promise<void>,
  errorEvent: (error: string) => T,
  options?: { signal?: AbortSignal },
): Response {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  if (options?.signal) {
    if (options.signal.aborted) abortController.abort();
    else options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: T) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeNdjsonLine(event)));
        } catch (error) {
          closed = true;
          log.debug(`Visual event enqueue after close ignored: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      try {
        await producer(emit, abortController.signal);
      } catch (error) {
        log.warn('JSON event producer failed', error);
        emit(errorEvent(error instanceof Error ? error.message : String(error)));
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser may have cancelled the reader already.
        }
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
}
