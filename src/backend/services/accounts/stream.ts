import { gateAccountRequest } from './requestAccess';

/** How often an open live-update stream checks that its person may still see it. */
export const STREAM_RECHECK_MS = 1000;

/**
 * Keep a live-update stream (server-sent events) bound to the person who
 * opened it (#574). Every second it asks the same question as the request
 * did; when the person signed out, was disabled, lost the workspace or the
 * mode broke, the stream ends. Other responses pass through unchanged.
 */
export function bindAccountStream(response: Response, request: Request, signal: AbortSignal,
  recheck: () => Promise<boolean> = async () => (await gateAccountRequest(request)).kind === 'allowed'): Response {
  if (!response.body || response.headers.get('content-type')?.split(';')[0].trim() !== 'text/event-stream') {
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const dispose = () => {
    if (finished) return false;
    finished = true;
    clearInterval(timer);
    signal.removeEventListener('abort', stop);
    return true;
  };
  function stop() {
    if (!dispose()) return;
    controller.error(new Error('Stream authorization ended.'));
    void reader.cancel().catch(() => undefined);
  }
  const check = async () => {
    if (finished || checking) return;
    checking = true;
    try {
      if (signal.aborted || !(await recheck())) stop();
    } catch {
      stop();
    } finally {
      checking = false;
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', stop, { once: true });
      // An idle stream must still end when access goes, even while the reader applies backpressure.
      timer = setInterval(() => { void check(); }, STREAM_RECHECK_MS);
      timer.unref?.();
    },
    async pull() {
      if (finished) return;
      try {
        const next = await reader.read();
        if (finished) return;
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
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
