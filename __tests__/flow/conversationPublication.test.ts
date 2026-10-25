import vm from 'node:vm';
import { publishConversation, conversationJsonChunks, getConversationPublicationDiagnostics,
  CONVERSATION_PUBLICATION_LIMITS, fenceConversationPublication } from '@/backend/execution/flow/conversationPublication';
import { getAllocationReservationSnapshot } from '@/backend/execution/flow/allocationReservations';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
afterEach(() => {
  expect(getConversationPublicationDiagnostics()).toMatchObject({ allocationBytes: 0, retainedBytes: 0, writers: 0, queuedWriters: 0, chains: 0 });
  expect(getAllocationReservationSnapshot().publication).toBe(0);
});

it('captures containers before a blocked predecessor and shares owned strings', async () => {
  const blocked = gate();
  const first = publishConversation('capture', null, async () => blocked.promise);
  const value = { nested: { text: 'x'.repeat(2_000_000) }, media: [{ uri: 'run-resource://media' }] };
  const text = value.nested.text;
  let result: typeof value | undefined;
  const second = publishConversation('capture', value, async owned => { result = owned; });
  value.nested.text = 'changed'; value.media[0].uri = 'changed';
  expect(getConversationPublicationDiagnostics().retainedBytes).toBeGreaterThan(4_000_000);
  blocked.release(); await Promise.all([first, second]);
  expect(result!.nested.text).toBe(text);
  expect(result!.media[0].uri).toBe('run-resource://media');
  expect(result!.nested).not.toBe(value.nested);
});

it('bounds queued owners and simultaneous writers without dropping accepted work', async () => {
  const blocked = gate(); let completed = 0;
  const pending = Array.from({ length: CONVERSATION_PUBLICATION_LIMITS.owners }, (_, index) =>
    publishConversation(`queue-${index}`, { index }, async () => { await blocked.promise; completed++; }));
  expect(() => publishConversation('overflow', {}, async () => undefined)).toThrow(expect.objectContaining({ code: 'CONVERSATION_PUBLICATION_BUSY' }));
  await new Promise(resolve => setImmediate(resolve));
  expect(getConversationPublicationDiagnostics()).toMatchObject({ writers: 4, queuedWriters: 60, owners: 64 });
  blocked.release(); await Promise.all(pending);
  expect(completed).toBe(64);
});

it('preserves JSON semantics, foreign plain records, aliases, Unicode, and omitted values', async () => {
  const foreign = vm.runInNewContext('({ a: [1, undefined, NaN, "🌈"], nested: { value: "foreign" } })');
  const shared = { text: '\u0000\\"\ud800🌈' };
  const value = { foreign, shared, alias: shared, toJSON: 'ordinary data', absent: undefined, fn: () => {}, symbol: Symbol('s'), array: [undefined, () => {}, Symbol('s'), Infinity] };
  const expected = JSON.stringify(value);
  await publishConversation('semantics', value, async owned => {
    const chunks = [...conversationJsonChunks([owned], false)].map(chunk => Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe(expected);
  });
});

it('refuses proxies, accessors, and custom serialization before invoking any hook', () => {
  const invoked = jest.fn();
  const getter = Object.defineProperty({}, 'content', { enumerable: true, get: invoked });
  for (const value of [getter, { toJSON: invoked }, new Proxy({}, { ownKeys: invoked }), Object.create(new Proxy({}, { getPrototypeOf: invoked }))]) {
    expect(() => publishConversation('unsafe', value, async () => undefined)).toThrow(expect.objectContaining({ code: 'CONVERSATION_PUBLICATION_DATA' }));
  }
  expect(invoked).not.toHaveBeenCalled();
});

it('admits the original 37.6M-character history without serialization or whole-string cloning', async () => {
  const lane = 'x'.repeat(4_450_000);
  const messages = [{ content: 'p'.repeat(2_000_000) }, ...Array.from({ length: 8 }, () => ({ content: lane, media: [{ uri: 'run-resource://media' }] }))];
  const stringify = jest.spyOn(JSON, 'stringify');
  try {
    await publishConversation('legitimate-history', messages, async owned => {
      expect(stringify).not.toHaveBeenCalled();
      expect(owned[8].content).toBe(lane);
      expect(getConversationPublicationDiagnostics().retainedBytes).toBeGreaterThanOrEqual(75_200_000);
      expect(getConversationPublicationDiagnostics().allocationBytes).toBeLessThan(1024 * 1024);
    });
  } finally { stringify.mockRestore(); }
});

it('bounds encoded chunks and emits lone surrogates and split surrogate pairs exactly', async () => {
  const text = `${'x'.repeat(8191)}🌈${'\u0000'.repeat(70_000)}\ud800`;
  await publishConversation('encoding', { text }, async owned => {
    const copies: Buffer[] = [];
    for (const chunk of conversationJsonChunks([owned], true)) {
      expect(chunk.length).toBeLessThanOrEqual(64 * 1024); copies.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(copies).toString('utf8')).toBe(`${JSON.stringify({ text })}\n`);
  });
});

it('releases captures but keeps a finite fence after uncertain publication', async () => {
  const before = getConversationPublicationDiagnostics().owners;
  await expect(publishConversation('uncertain', { content: 'x'.repeat(100_000) }, async () => {
    throw fenceConversationPublication('test unknown commit');
  })).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: before + 1, fences: 1, allocationBytes: 0, retainedBytes: 0 });
  expect(() => publishConversation('uncertain', {}, async () => undefined)).toThrow(expect.objectContaining({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' }));
});

it('serializes nested siblings, permits grandchildren, and holds the outer writer until detached children settle', async () => {
  const blocked = gate(), entered = gate(); const trace: string[] = [];
  const root = publishConversation('nested', null, async () => {
    void publishConversation('nested', {}, async () => {
      trace.push('first'); entered.release(); await blocked.promise;
      await publishConversation('nested', {}, async () => { trace.push('grandchild'); });
    });
    void publishConversation('nested', {}, async () => { trace.push('second'); });
  });
  const later = publishConversation('nested', null, async () => { trace.push('later root'); });
  await entered.promise;
  expect(trace).toEqual(['first']);
  expect(getConversationPublicationDiagnostics().writers).toBe(1);
  blocked.release(); await Promise.all([root, later]);
  expect(trace).toEqual(['first', 'grandchild', 'second', 'later root']);
});

it('wakes every queued owner when all descriptor slots become quarantined', async () => {
  const blocked = gate();
  const operations = Array.from({ length: 12 }, (_, index) => publishConversation(`close-${index}`, {}, async () => {
    await blocked.promise;
    throw fenceConversationPublication('test uncertain close', undefined, true);
  }));
  const settled = Promise.allSettled(operations);
  await new Promise(resolve => setImmediate(resolve));
  expect(getConversationPublicationDiagnostics()).toMatchObject({ writers: 4, queuedWriters: 8 });
  blocked.release();
  expect((await settled).every(result => result.status === 'rejected')).toBe(true);
  expect(getConversationPublicationDiagnostics()).toMatchObject({ writers: 0, queuedWriters: 0, quarantinedWriterSlots: 4 });
});
