export const AVATARS = Object.freeze(['moss', 'orbit', 'spark']);
export class PublicError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export async function readResponse(response, maximum = 64 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maximum) throw new PublicError(502, 'invalid_upstream_response', 'The voice service returned an invalid response.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
