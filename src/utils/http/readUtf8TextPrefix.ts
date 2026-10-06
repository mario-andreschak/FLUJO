const DECODE_SEGMENT_BYTES = 64 * 1024;

/** Read the Response.text() UTF-8 prefix without consuming the unused tail. */
export async function readUtf8TextPrefix(response: Response, maxCodeUnits: number): Promise<string> {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 0) {
    throw new RangeError('Text prefix limit must be a non-negative safe integer.');
  }
  if (response.body === null) return '';

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const parts: string[] = [];
  let remaining = maxCodeUnits;
  let reachedEof = false;
  const append = (text: string) => {
    const prefix = text.slice(0, remaining);
    if (prefix) parts.push(prefix);
    remaining -= prefix.length;
  };

  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        append(decoder.decode());
        break;
      }
      // A transport may already have allocated a large chunk. Do not also
      // materialize that entire chunk as a decoded string.
      for (let offset = 0; offset < value.byteLength && remaining > 0; offset += DECODE_SEGMENT_BYTES) {
        append(decoder.decode(value.subarray(offset, offset + DECODE_SEGMENT_BYTES), { stream: true }));
      }
    }
    return parts.join('');
  } finally {
    try {
      if (!reachedEof) {
        // Cancellation can reject or never settle. Neither may delay a full
        // prefix or replace the original read error. Own its rejection now.
        void reader.cancel().catch(() => {});
      }
    } catch {
      // Preserve the prefix/read error even if cancellation throws synchronously.
    } finally {
      reader.releaseLock();
    }
  }
}
