/**
 * Unit tests for the shared NDJSON streaming plumbing (issues #64, #65).
 *
 * Covers the pure encode/parse core (`@/shared/utils/ndjson`) and the frontend reader
 * (`@/frontend/utils/ndjsonReader`), including the awkward cases that a naive line-split
 * gets wrong: a JSON object split across two network reads, several objects arriving in
 * one read, a trailing line with no newline, and a malformed line in the middle.
 */

import { encodeNdjsonLine, createNdjsonParser } from '@/shared/utils/ndjson';
import { readNdjsonStream } from '@/frontend/utils/ndjsonReader';
import { CommandStreamEvent } from '@/shared/types/streaming';

describe('encodeNdjsonLine', () => {
  it('serialises a value as one JSON line terminated by a single newline', () => {
    const line = encodeNdjsonLine({ type: 'stderr', data: 'hi' });
    expect(line).toBe('{"type":"stderr","data":"hi"}\n');
  });

  it('round-trips through the parser', () => {
    const event = { type: 'result', success: true, data: { toolCount: 3 } };
    const parser = createNdjsonParser();
    expect(parser.push(encodeNdjsonLine(event))).toEqual([event]);
  });
});

describe('createNdjsonParser', () => {
  it('emits each complete line and buffers a partial trailing line', () => {
    const parser = createNdjsonParser<{ n: number }>();
    // First chunk ends mid-object.
    expect(parser.push('{"n":1}\n{"n":2}\n{"n":')).toEqual([{ n: 1 }, { n: 2 }]);
    // Second chunk completes the buffered object.
    expect(parser.push('3}\n')).toEqual([{ n: 3 }]);
  });

  it('flush() emits a final line that had no terminating newline', () => {
    const parser = createNdjsonParser<{ n: number }>();
    expect(parser.push('{"n":1}')).toEqual([]);
    expect(parser.flush()).toEqual([{ n: 1 }]);
  });

  it('skips a malformed line without aborting the stream', () => {
    const parser = createNdjsonParser<{ ok: boolean }>();
    const out = parser.push('{"ok":true}\nNOT JSON\n{"ok":false}\n');
    expect(out).toEqual([{ ok: true }, { ok: false }]);
  });

  it('ignores blank lines', () => {
    const parser = createNdjsonParser();
    expect(parser.push('\n\n')).toEqual([]);
  });
});

/** Build a Response-like object whose body streams the given string chunks. */
function fakeStreamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const reader = {
    read: async () =>
      i < chunks.length
        ? { value: encoder.encode(chunks[i++]), done: false }
        : { value: undefined, done: true },
    releaseLock: () => undefined,
  };
  return { body: { getReader: () => reader } } as unknown as Response;
}

describe('readNdjsonStream', () => {
  it('delivers events across arbitrary chunk boundaries', async () => {
    const events = [
      { type: 'status', phase: 'spawning' },
      { type: 'stderr', data: 'booting\n' },
      { type: 'result', success: true, data: { toolCount: 1 } },
    ];
    const wire = events.map(encodeNdjsonLine).join('');
    // Split the wire bytes into deliberately ugly chunks.
    const chunks = [wire.slice(0, 5), wire.slice(5, 30), wire.slice(30)];

    const received: CommandStreamEvent[] = [];
    await readNdjsonStream(fakeStreamingResponse(chunks), (e) => received.push(e));

    expect(received).toEqual(events);
  });

  it('emits a trailing line even without a final newline', async () => {
    const received: CommandStreamEvent[] = [];
    await readNdjsonStream(
      fakeStreamingResponse(['{"type":"result","success":true}']),
      (e) => received.push(e)
    );
    expect(received).toEqual([{ type: 'result', success: true }]);
  });

  it('throws when the response has no streamable body (caller can fall back)', async () => {
    await expect(
      readNdjsonStream({ body: null } as unknown as Response, () => undefined)
    ).rejects.toThrow(/no readable body/i);
  });
});
