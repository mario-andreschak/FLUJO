/**
 * Pure NDJSON (newline-delimited JSON) framing helpers (issues #64, #65).
 *
 * NDJSON was chosen over SSE for FLUJO's one-shot command streams: it is trivial to
 * produce (`JSON.stringify(x) + "\n"`) and to consume with a `fetch().body.getReader()`
 * plus a line splitter, and it does not carry SSE's auto-reconnect semantics that we do
 * not want for a single Test Run / Install / Build.
 *
 * These functions are intentionally free of any Node/DOM API (no streams, no
 * TextEncoder/Decoder) so they can be unit-tested directly and shared verbatim by the
 * backend Response builder and the frontend reader.
 */

/** Frame a single value as one NDJSON line (JSON + trailing newline). */
export function encodeNdjsonLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

export interface NdjsonParser<T> {
  /** Feed a decoded string chunk; returns every event completed by this chunk. */
  push(chunk: string): T[];
  /** Emit any buffered trailing line that had no terminating newline. */
  flush(): T[];
}

/**
 * Create a stateful line parser. Chunks arriving from the network can split a JSON
 * object across reads, so the parser buffers the incomplete tail between `push` calls
 * and only parses whole lines. Malformed lines are skipped rather than throwing, so a
 * single corrupt frame cannot abort the whole stream.
 */
export function createNdjsonParser<T = unknown>(): NdjsonParser<T> {
  let buffer = '';

  const parseLine = (raw: string, out: T[]): void => {
    const line = raw.trim();
    if (!line) return;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip a malformed/partial line rather than tearing down the stream.
    }
  };

  return {
    push(chunk: string): T[] {
      buffer += chunk;
      const out: T[] = [];
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        parseLine(buffer.slice(0, idx), out);
        buffer = buffer.slice(idx + 1);
      }
      return out;
    },
    flush(): T[] {
      const out: T[] = [];
      parseLine(buffer, out);
      buffer = '';
      return out;
    },
  };
}
