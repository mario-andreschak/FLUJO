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

it('ends a full group\'s turn in a pass but still tries the other groups (a burst once retried every waiter)', async () => {
  const queue = new CapacityWaitQueue();
  const context = new AsyncLocalStorage<string>();
  const free: Record<string, number> = { a: 0, b: 0 };
  const attempts: string[] = [];
  const take = () => {
    const group = context.getStore()!;
    attempts.push(group);
    if (free[group] <= 0) throw new Busy(group);
    free[group] -= 1;
    return group;
  };
  const groupRules = { ...rules, group: () => context.getStore()!, blocksGroup: (_refusal: unknown, group: string) => free[group] <= 0 };
  const waiting = ['a', 'a', 'a', 'b', 'b', 'a'].map(group =>
    context.run(group, () => queue.acquire(take, groupRules, { deadline: Date.now() + 5000 })));
  attempts.length = 0;
  queue.wake();
  expect(attempts).toEqual(['a', 'b']);
  attempts.length = 0;
  free.b = 2;
  queue.wake();
  expect(attempts).toEqual(['a', 'b', 'b']);
  await expect(Promise.all(waiting.slice(3, 5))).resolves.toEqual(['b', 'b']);
  free.a = 4;
  queue.wake();
  await expect(Promise.all([...waiting.slice(0, 3), waiting[5]])).resolves.toEqual(['a', 'a', 'a', 'a']);
  expect(queue.size).toBe(0);
});

it('gives a waiter skipped behind its full group that group\'s refusal at the deadline', async () => {
  const queue = new CapacityWaitQueue();
  const refusal = new Busy('workspace full');
  const groupRules = { ...rules, group: () => 'workspace', blocksGroup: () => true };
  const first = queue.acquire(() => { throw refusal; }, groupRules, { deadline: Date.now() + 80 });
  let tried = false;
  const skipped = queue.acquire(() => { tried = true; throw new Busy('never built'); }, groupRules, { deadline: Date.now() + 40 });
  await expect(skipped).rejects.toBe(refusal);
  expect(tried).toBe(false);
  await expect(first).rejects.toBe(refusal);
  expect(queue.size).toBe(0);
});
