/**
 * Property-based checks for the conversation publication ledger (issue #1424).
 *
 * fast-check generates random bursts of saves across several conversations,
 * random failure kinds and random interleavings of every await. Each run must
 * keep the invariants the rest of FLUJO relies on:
 *
 * - every submitted item is written exactly once, in submission order per conversation;
 * - one transaction per conversation at a time, never more writers than the limit;
 * - each caller's promise reports the outcome of the write that carried its item;
 * - a failure fences only until the next complete transaction, and never blocks it;
 * - every slot, quarantine, byte charge, batch and chain is released afterwards.
 *
 * The model in docs/formal/ConversationWriteHealing.tla states the same healing
 * rules across processes and crashes.
 */
import fc from 'fast-check';
import { getAllocationReservationSnapshot } from '@/backend/execution/flow/allocationReservations';

// The run memory ceiling is not under test here, and loading the real module
// for every run would make each fresh ledger slow.
jest.mock('@/backend/execution/flow/runAdmission', () => ({
  getFlowRunAdmissionDiagnostics: () => ({ maxRssBytes: Number.POSITIVE_INFINITY }),
}));

type Ledger = typeof import('@/backend/execution/flow/conversationPublication');
const KEYS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
const OWNERS = [undefined, { run: 1 }, { run: 2 }] as const;
type Outcome = 'ok' | 'throw' | 'fence' | 'quarantine' | 'fenceThenOk';
type Operation = { key: typeof KEYS[number]; batch: boolean; owner: 0 | 1 | 2; outcome: Outcome };
type Item = { id: number };
type Write = { key: string; ids: number[]; outcome: Outcome };

const operation: fc.Arbitrary<Operation> = fc.record({
  key: fc.constantFrom(...KEYS),
  batch: fc.boolean(),
  owner: fc.constantFrom(0 as const, 1 as const, 2 as const),
  outcome: fc.constantFrom<Outcome>('ok', 'ok', 'ok', 'throw', 'fence', 'quarantine', 'fenceThenOk'),
});

/** Each run gets its own ledger, so a leak fails that run and shrinks to its cause. */
function freshLedger(): Ledger {
  const host = globalThis as { __flujoConversationPublicationV1?: { context?: { disable(): void } } };
  // Every enabled async context slows each later await; retire the previous one.
  host.__flujoConversationPublicationV1?.context?.disable();
  delete host.__flujoConversationPublicationV1;
  let ledger: Ledger | undefined;
  jest.isolateModules(() => { ledger = require('@/backend/execution/flow/conversationPublication'); });
  return ledger!;
}

/** A leaked writer slot or chain fails the run with this error instead of hanging the suite. */
function settleWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} never settled: a writer slot, chain or batch stayed blocked`)), 5_000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

it('writes every item once, in order, and heals every fence, slot and charge', async () => {
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 24 }), fc.scheduler(), async (operations, s) => {
    const {
      CONVERSATION_PUBLICATION_LIMITS, fenceConversationPublication, flushConversationPublication,
      getConversationPublicationDiagnostics, publishConversation, publishConversationBatch,
    } = freshLedger();
    const submitted = new Map<string, number[]>();
    const writes: Write[] = [];
    const writeOf = new Map<number, Write>();
    const activeKeys = new Set<string>();
    const violations: string[] = [];
    let active = 0;

    const task = (key: string, outcome: Outcome) => async (owned: Item[]) => {
      if (activeKeys.has(key)) violations.push(`two transactions of ${key} overlapped`);
      activeKeys.add(key); active++;
      const { writers } = getConversationPublicationDiagnostics();
      if (Math.max(active, writers) > CONVERSATION_PUBLICATION_LIMITS.writers) violations.push(`${Math.max(active, writers)} writers ran at once`);
      const write: Write = { key, ids: owned.map(item => item.id), outcome };
      writes.push(write);
      for (const id of write.ids) {
        if (writeOf.has(id)) violations.push(`item ${id} was written twice`);
        writeOf.set(id, write);
      }
      try {
        await s.schedule(Promise.resolve(), `${key} writes [${write.ids}] -> ${outcome}`);
        if (outcome === 'throw') throw new Error('write failed before any fence');
        if (outcome === 'fence') throw fenceConversationPublication('append outcome unknown');
        if (outcome === 'quarantine') throw fenceConversationPublication('descriptor close unknown', undefined, true);
        if (outcome === 'fenceThenOk') fenceConversationPublication('uncertain step later confirmed');
      } finally {
        activeKeys.delete(key); active--;
      }
    };

    const submissions = operations.map((op, id) => s.schedule(Promise.resolve(), `submit #${id}`).then(() => {
      submitted.set(op.key, [...submitted.get(op.key) ?? [], id]);
      const item: Item = { id };
      const settled = op.batch
        ? publishConversationBatch(op.key, item, task(op.key, op.outcome), OWNERS[op.owner])
        : publishConversation(op.key, [item], task(op.key, op.outcome));
      return settled.then(() => ({ id, ok: true }), () => ({ id, ok: false }));
    }));
    const results = await settleWithin(s.waitFor(Promise.all(submissions)), 'A generated burst');
    expect(violations).toEqual([]);

    // Exactly once, in submission order per conversation.
    expect([...writeOf.keys()].sort((x, y) => x - y)).toEqual(operations.map((_, id) => id));
    for (const [key, ids] of submitted) {
      expect(writes.filter(write => write.key === key).flatMap(write => write.ids)).toEqual(ids);
    }
    // Each caller learns the outcome of the write that carried its item.
    for (const { id, ok } of results) {
      expect(ok).toBe(['ok', 'fenceThenOk'].includes(writeOf.get(id)!.outcome));
    }
    // A fence stays only while the latest transaction of that conversation failed with one.
    for (const key of submitted.keys()) {
      let fenced = false;
      for (const write of writes.filter(entry => entry.key === key)) {
        if (write.outcome === 'ok' || write.outcome === 'fenceThenOk') fenced = false;
        else if (write.outcome !== 'throw') fenced = true;
      }
      expect(await flushConversationPublication(key).then(() => false, () => true)).toBe(fenced);
    }
    // Nothing stays reserved once the burst has settled.
    expect(getConversationPublicationDiagnostics()).toMatchObject({
      owners: 0, writers: 0, quarantinedWriterSlots: 0, queuedWriters: 0,
      allocationBytes: 0, retainedBytes: 0, openBatches: 0, chains: 0,
    });
    expect(getAllocationReservationSnapshot().publication).toBe(0);
    // The next ordinary write is admitted and clears whatever fence remained.
    for (const key of submitted.keys()) {
      await settleWithin(publishConversation(key, null, async () => undefined), `The write after ${key}`);
      await expect(flushConversationPublication(key)).resolves.toBeUndefined();
    }
    expect(getConversationPublicationDiagnostics().fences).toBe(0);
  }), { numRuns: 200 });
});
