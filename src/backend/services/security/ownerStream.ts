import type { OwnerRequestAuthorization } from './ownerAccess';

/** Keep an established SSE subscription bound to its original durable grant. */
export function bindOwnerStream(response: Response, authorization: OwnerRequestAuthorization,
  signal: AbortSignal): Response {
  const denied = authorization.recheck();
  if (denied) {
    void response.body?.cancel().catch(() => undefined);
    return denied;
  }
  if (!response.body || response.headers.get('content-type')?.split(';')[0].trim() !== 'text/event-stream') {
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const dispose = () => {
    if (finished) return false;
    finished = true;
    clearInterval(timer);
    signal.removeEventListener('abort', abort);
    return true;
  };
  const stop = () => {
    if (!dispose()) return;
    // A generic error discards queued bytes without leaking policy diagnostics.
    controller.error(new Error('Stream authorization ended.'));
    void reader.cancel().catch(() => undefined);
  };
  const abort = () => stop();
  const valid = () => {
    if (finished) return false;
    if (signal.aborted || authorization.recheck()) { stop(); return false; }
    return true;
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', abort, { once: true });
      if (!valid()) return;
      // Idle subscriptions must revoke even when the consumer applies backpressure.
      timer = setInterval(valid, 1000);
      timer.unref?.();
    },
    async pull() {
      if (!valid()) return;
      try {
        const next = await reader.read();
        if (!valid()) return;
        if (next.done) {
          dispose();
          controller.close();
          reader.releaseLock();
        } else controller.enqueue(next.value);
      } catch {
        stop();
      }
    },
    async cancel() {
      if (dispose()) await reader.cancel();
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}
