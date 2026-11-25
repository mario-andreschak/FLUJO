/** #757: callers wait for momentarily full capacity in arrival order, never forever. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { CapacityWaitQueue } from '@/utils/capacityWaitQueue';

class Busy extends Error {}
const rules = { waitable: (refusal: unknown) => refusal instanceof Busy };

function slots(free: number) {
  const pool = {
    free,
    take: () => { if (pool.free <= 0) throw new Busy('full'); pool.free -= 1; return 'slot'; },
  };
  return pool;
}

it('admits at once while capacity is free', async () => {
  const queue = new CapacityWaitQueue();
  const pool = slots(1);
  await expect(queue.acquire(pool.take, rules, { deadline: Date.now() + 1000 })).resolves.toBe('slot');
  expect(queue.size).toBe(0);
});

it('admits waiters in arrival order the moment capacity frees', async () => {
  const queue = new CapacityWaitQueue();
  const pool = slots(0);
  const order: number[] = [];
  const waiting = [0, 1, 2].map(index => queue.acquire(pool.take, rules, { deadline: Date.now() + 5000 })
    .then(() => { order.push(index); }));
  expect(queue.size).toBe(3);
  pool.free = 2;
  const freedAt = performance.now();
  queue.wake();
  await Promise.all(waiting.slice(0, 2));
  expect(performance.now() - freedAt).toBeLessThan(100);
  expect(order).toEqual([0, 1]);
  pool.free = 1;
  queue.wake();
  await waiting[2];
  expect(order).toEqual([0, 1, 2]);
  expect(queue.size).toBe(0);
});

it('does not let a newcomer overtake earlier waiters', async () => {
  const queue = new CapacityWaitQueue();
  const pool = slots(0);
  const order: string[] = [];
  const first = queue.acquire(pool.take, rules, { deadline: Date.now() + 5000 }).then(() => order.push('first'));
  pool.free = 1;
  const second = queue.acquire(pool.take, rules, { deadline: Date.now() + 5000 }).then(() => order.push('second'));
  await first;
  pool.free = 1;
  queue.wake();
  await second;
  expect(order).toEqual(['first', 'second']);
});

it('ends a wait at its deadline or abort with the last refusal, and frees nothing it never took', async () => {
  const queue = new CapacityWaitQueue();
  const pool = slots(0);
  await expect(queue.acquire(pool.take, rules, { deadline: Date.now() + 30 })).rejects.toBeInstanceOf(Busy);
  const controller = new AbortController();
  const leaving = queue.acquire(pool.take, rules, { deadline: Date.now() + 5000, signal: controller.signal });
  controller.abort();
  await expect(leaving).rejects.toBeInstanceOf(Busy);
  expect(queue.size).toBe(0);
  pool.free = 1;
  queue.wake();
  expect(pool.free).toBe(1);
});

it('fails at once for a refusal that waiting cannot clear', async () => {
  const queue = new CapacityWaitQueue();
  const tooLarge = new Error('too large');
  await expect(queue.acquire(() => { throw tooLarge; }, rules, { deadline: Date.now() + 5000 })).rejects.toBe(tooLarge);
  expect(queue.size).toBe(0);
});

it('retries on its own for pressure that no release announces', async () => {
  const queue = new CapacityWaitQueue();
  const pool = slots(0);
  const waiting = queue.acquire(pool.take, rules, { deadline: Date.now() + 5000 });
  setTimeout(() => { pool.free = 1; }, 20);
  await expect(waiting).resolves.toBe('slot');
});

it('stops a pass at a refusal that holds for every waiter', async () => {
  const queue = new CapacityWaitQueue();
  let attempts = 0;
  const full = () => { attempts += 1; throw new Busy('full'); };
  const waiting = Array.from({ length: 5 }, () => queue.acquire(full, { ...rules, blocksAll: () => true },
    { deadline: Date.now() + 50 }).catch(() => undefined));
  attempts = 0;
  queue.wake();
  expect(attempts).toBe(1);
  await Promise.all(waiting);
});

it('tries each waiter in its own async context, even when another caller frees capacity', async () => {
  const queue = new CapacityWaitQueue();
  const context = new AsyncLocalStorage<string>();
  const pool = slots(0);
  const seen: Array<string | undefined> = [];
  const take = () => { seen.push(context.getStore()); return pool.take(); };
  const waiting = context.run('waiter-workspace', () => queue.acquire(take, rules, { deadline: Date.now() + 5000 }));
  pool.free = 1;
  context.run('releasing-workspace', () => queue.wake());
  await waiting;
  expect(seen.at(-1)).toBe('waiter-workspace');
});
