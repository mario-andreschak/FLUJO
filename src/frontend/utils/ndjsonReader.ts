import { CommandStreamEvent } from '@/shared/types/streaming';
import { createNdjsonParser } from '@/shared/utils/ndjson';

/**
 * Consume an NDJSON HTTP response body, invoking `onEvent` for each parsed line as it
 * arrives. Shared frontend plumbing for FLUJO's command streams (issues #64, #65).
 *
 * Resolves once the stream ends (all lines delivered). Throws if the response has no
 * readable body (e.g. a buffering proxy that returned a normal JSON blob) so callers can
 * fall back to the non-streaming request.
 */
export async function readNdjsonStream(
  response: Response,
  onEvent: (event: CommandStreamEvent) => void
): Promise<void> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Response has no readable body to stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createNdjsonParser<CommandStreamEvent>();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        onEvent(event);
      }
    }
    // Flush the decoder and any trailing line without a newline.
    const tail = decoder.decode();
    if (tail) {
      for (const event of parser.push(tail)) onEvent(event);
    }
    for (const event of parser.flush()) onEvent(event);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
