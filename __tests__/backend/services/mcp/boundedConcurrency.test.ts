import { runWithConcurrency } from '@/backend/services/mcp/utils/boundedConcurrency';

/**
 * Unit tests for the bounded async worker pool that backs the MCP boot sweep
 * (issue #129 item 1). The core invariant we care about is: no more than `limit`
 * tasks are ever in flight at once, while still processing every item.
 */
describe('runWithConcurrency', () => {
  // A controllable async task that lets the test observe peak concurrency.
  function makeTracker() {
    let inFlight = 0;
    let peak = 0;
    const processed: number[] = [];
    const task = async (item: number): Promise<void> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield a couple of microtasks so overlapping tasks actually coexist.
      await Promise.resolve();
      await Promise.resolve();
      processed.push(item);
      inFlight--;
    };
    return { task, get peak() { return peak; }, processed };
  }

  it('never exceeds the concurrency limit', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const t = makeTracker();
    await runWithConcurrency(items, 2, t.task);
    expect(t.peak).toBeLessThanOrEqual(2);
    expect(t.processed.sort((a, b) => a - b)).toEqual(items);
  });

  it('processes every item even when there are fewer items than the limit', async () => {
    const items = [0, 1];
    const t = makeTracker();
    await runWithConcurrency(items, 8, t.task);
    // poolSize is min(limit, items.length) => at most 2 here.
    expect(t.peak).toBeLessThanOrEqual(2);
    expect(t.processed.sort((a, b) => a - b)).toEqual(items);
  });

  it('is a no-op for an empty list', async () => {
    const t = makeTracker();
    await runWithConcurrency([], 4, t.task);
    expect(t.processed).toEqual([]);
    expect(t.peak).toBe(0);
  });

  it('floors a non-positive/NaN limit at 1 (serial execution)', async () => {
    const items = [0, 1, 2, 3];
    const t = makeTracker();
    await runWithConcurrency(items, 0, t.task);
    expect(t.peak).toBe(1);
    expect(t.processed.sort((a, b) => a - b)).toEqual(items);

    const t2 = makeTracker();
    await runWithConcurrency(items, Number.NaN, t2.task);
    expect(t2.peak).toBe(1);
  });

  it('rejects if a task throws (matches the Promise.all it replaces)', async () => {
    const items = [0, 1, 2];
    const task = async (i: number): Promise<void> => {
      if (i === 1) throw new Error('boom');
    };
    await expect(runWithConcurrency(items, 2, task)).rejects.toThrow('boom');
  });

  it('completes all items when the caller swallows per-item errors (boot-sweep semantics)', async () => {
    const items = [0, 1, 2, 3];
    const processed: number[] = [];
    const task = async (i: number): Promise<void> => {
      try {
        if (i % 2 === 0) throw new Error(`fail-${i}`);
        processed.push(i);
      } catch {
        // swallow, exactly as startEnabledServers wraps connectServer
      }
    };
    await expect(runWithConcurrency(items, 2, task)).resolves.toBeUndefined();
    expect(processed.sort((a, b) => a - b)).toEqual([1, 3]);
  });
});
