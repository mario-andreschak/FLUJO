import vm from 'node:vm';
import { publishConversation, publishConversationBatch, conversationJsonChunks, getConversationPublicationDiagnostics,
  CONVERSATION_PUBLICATION_LIMITS, fenceConversationPublication, freezeConversationSnapshot, flushConversationPublication,
  retryConversationPublication, ConversationPublicationError } from '@/backend/execution/flow/conversationPublication';
import { getAllocationReservationSnapshot } from '@/backend/execution/flow/allocationReservations';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
afterEach(() => {
  expect(getConversationPublicationDiagnostics()).toMatchObject({ allocationBytes: 0, retainedBytes: 0, writers: 0, queuedWriters: 0, openBatches: 0, chains: 0 });
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

it('queues any number of publications without a count cap and bounds simultaneous writers', async () => {
  const blocked = gate(); let completed = 0;
  const pending = Array.from({ length: 200 }, (_, index) =>
    publishConversation(`queue-${index}`, { index }, async () => { await blocked.promise; completed++; }));
  await new Promise(resolve => setImmediate(resolve));
  expect(getConversationPublicationDiagnostics()).toMatchObject({ writers: CONVERSATION_PUBLICATION_LIMITS.writers, queuedWriters: 196, owners: 200 });
  blocked.release(); await Promise.all(pending);
  expect(completed).toBe(200);
  expect(getConversationPublicationDiagnostics().owners).toBe(0);
});

it('group-commits a burst of events into one ordered write', async () => {
  const blocked = gate();
  const head = publishConversation('burst', null, async () => blocked.promise);
  const writes: number[][] = [];
  const pending = Array.from({ length: 150 }, (_, index) =>
    publishConversationBatch('burst', { index }, async owned => { writes.push(owned.map(item => item.index)); }));
  expect(new Set(pending).size).toBe(1);
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: 2, openBatches: 1 });
  blocked.release(); await Promise.all([head, ...pending]);
  expect(writes).toEqual([Array.from({ length: 150 }, (_, index) => index)]);
});

it('never lets a batch overtake a later publication or join a write already in progress', async () => {
  const blocked = gate(); const order: string[] = [];
  const head = publishConversation('order', null, async () => blocked.promise);
  const first = publishConversationBatch('order', 'a', async owned => { order.push(...owned); });
  const between = publishConversation('order', null, async () => { order.push('snapshot'); });
  const second = publishConversationBatch('order', 'b', async owned => { order.push(...owned); });
  expect(second).not.toBe(first);
  blocked.release(); await Promise.all([head, first, between, second]);
  expect(order).toEqual(['a', 'snapshot', 'b']);

  const writing = gate(); const writes: string[][] = [];
  const started = publishConversationBatch('started', 'x', async owned => { writes.push([...owned]); await writing.promise; });
  await new Promise(resolve => setImmediate(resolve));
  const later = publishConversationBatch('started', 'y', async owned => { writes.push([...owned]); });
  expect(later).not.toBe(started);
  writing.release(); await Promise.all([started, later]);
  expect(writes).toEqual([['x'], ['y']]);
});

it('only batches items committed by the same owner', async () => {
  const blocked = gate(); const writes: string[][] = [];
  const head = publishConversation('owners', null, async () => blocked.promise);
  const runA = {}, runB = {};
  const a = publishConversationBatch('owners', 'a1', async owned => { writes.push([...owned]); }, runA);
  expect(publishConversationBatch('owners', 'a2', async owned => { writes.push([...owned]); }, runA)).toBe(a);
  const b = publishConversationBatch('owners', 'b1', async owned => { writes.push([...owned]); }, runB);
  expect(b).not.toBe(a);
  blocked.release(); await Promise.all([head, a, b]);
  expect(writes).toEqual([['a1', 'a2'], ['b1']]);
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

it('borrows only a live immutable captured snapshot, keeping its original charge until nested settlement', async () => {
  const original = { messages: [{ content: 'x'.repeat(2_000_000) }] };
  let expired!: typeof original;
  await publishConversation('immutable', original, async owned => {
    Object.freeze(owned); // Even a pre-frozen root must have every child frozen.
    freezeConversationSnapshot(owned);
    expect(Object.isFrozen(owned.messages[0])).toBe(true);
    expect(Object.isFrozen(original.messages[0])).toBe(false);
    expired = owned;
    const retained = getConversationPublicationDiagnostics().retainedBytes;
    await publishConversation('immutable', owned, async nested => {
      expect(nested).toBe(owned);
      expect(getConversationPublicationDiagnostics().retainedBytes).toBe(retained);
    });
    await publishConversation('independent-owner', owned, async independent => {
      expect(independent).not.toBe(owned);
      expect(getConversationPublicationDiagnostics().retainedBytes).toBeGreaterThanOrEqual(retained * 2);
    });
  });
  await publishConversation('immutable', expired, async captured => {
    expect(captured).not.toBe(expired);
    expect(getConversationPublicationDiagnostics().retainedBytes).toBeGreaterThan(4_000_000);
  });
});

it('reports an uncertain publication once, without blocking or leaking, and heals on the next success', async () => {
  const before = getConversationPublicationDiagnostics().owners;
  await expect(publishConversation('uncertain', { content: 'x'.repeat(100_000) }, async () => {
    throw fenceConversationPublication('test unknown commit');
  })).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: before, fences: 1, allocationBytes: 0, retainedBytes: 0 });
  await expect(flushConversationPublication('uncertain')).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  // The next write is admitted; its success clears the fence.
  await expect(publishConversation('uncertain', {}, async () => 'written')).resolves.toBe('written');
  await expect(flushConversationPublication('uncertain')).resolves.toBeUndefined();
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: before, fences: 0 });
});

it('retries a transient failure and gives up on data errors', async () => {
  let attempts = 0;
  await expect(publishConversation('transient', {}, () => retryConversationPublication(async () => {
    if (++attempts < 3) throw Object.assign(new Error('scanner holds the file'), { code: 'EBUSY' });
    return 'ok';
  }))).resolves.toBe('ok');
  expect(attempts).toBe(3);
  attempts = 0;
  await expect(publishConversation('permanent', {}, () => retryConversationPublication(async () => {
    attempts++;
    throw new ConversationPublicationError('CONVERSATION_PUBLICATION_DATA', 'not JSON');
  }))).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_DATA' });
  expect(attempts).toBe(1);
});

it('charges a frozen capture handed from a live child to a queued sibling', async () => {
  const entered = gate(), release = gate();
  let snapshot!: { text: string };
  await publishConversation('siblings-owned', null, async () => {
    const first = publishConversation('siblings-owned', { text: 'x'.repeat(2_000_000) }, async owned => {
      snapshot = freezeConversationSnapshot(owned); entered.release(); await release.promise;
    });
    await entered.promise;
    const second = publishConversation('siblings-owned', snapshot, async owned => {
      expect(owned).not.toBe(snapshot);
      expect(getConversationPublicationDiagnostics().retainedBytes).toBeGreaterThan(4_000_000);
    });
    expect(getConversationPublicationDiagnostics().retainedBytes).toBeGreaterThan(8_000_000);
    release.release(); await Promise.all([first, second]);
  });
});

it('charges a new root submitted from a settled child callback while its ancestor capture is live', async () => {
  const submitted = gate();
  let late!: Promise<void>;
  await publishConversation('delayed-owned', { text: 'x'.repeat(2_000_000) }, async snapshot => {
    freezeConversationSnapshot(snapshot);
    await publishConversation('delayed-owned', null, async () => {
      setImmediate(() => {
        late = publishConversation('delayed-owned', snapshot, async owned => {
          expect(owned).not.toBe(snapshot);
          expect(getConversationPublicationDiagnostics().retainedBytes).toBeGreaterThan(4_000_000);
        });
        submitted.release();
      });
    });
    await submitted.promise;
    expect(getConversationPublicationDiagnostics().retainedBytes).toBeGreaterThan(8_000_000);
  });
  await late;
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

it('releases quarantined descriptor slots so later writers still run', async () => {
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
  expect(getConversationPublicationDiagnostics()).toMatchObject({ writers: 0, queuedWriters: 0, quarantinedWriterSlots: 0 });
  await expect(publishConversation('close-after', {}, async () => 'written')).resolves.toBe('written');
});
