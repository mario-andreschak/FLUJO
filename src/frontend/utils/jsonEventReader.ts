import { createNdjsonParser } from '@/shared/utils/ndjson';

/** Consume a typed NDJSON stream and preserve event order, including async animations. */
export async function readJsonEventStream<T>(
  response: Response,
  onEvent: (event: T) => void | Promise<void>,
): Promise<void> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Response has no readable body to stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createNdjsonParser<T>();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        await onEvent(event);
      }
    }
    const tail = decoder.decode();
    if (tail) {
      for (const event of parser.push(tail)) await onEvent(event);
    }
    for (const event of parser.flush()) await onEvent(event);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore an already-released stream.
    }
  }
}
