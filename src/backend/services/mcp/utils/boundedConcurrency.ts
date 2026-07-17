/**
 * Dependency-free bounded async worker pool.
 *
 * Mirrors the cursor-based worker pool used in
 * `src/backend/execution/flow/nodes/SubflowNode.ts`: a fixed number of workers
 * pull items off a shared cursor until the list is exhausted, so at most `limit`
 * invocations of `task` are ever in flight at once.
 *
 * This never rejects on a per-item failure: it is the caller's responsibility to
 * make `task` swallow its own errors (as the MCP boot sweep does with a
 * per-server `.catch`). If a `task` does throw, the whole pool rejects — matching
 * the semantics of the `Promise.all` it replaces.
 *
 * @param items  The work items to process.
 * @param limit  Maximum number of concurrent `task` invocations (floored at 1).
 * @param task   The async operation to run for each item.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;

  const safeLimit = Math.max(1, Math.floor(limit) || 1);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await task(items[i]);
    }
  };

  const poolSize = Math.min(safeLimit, items.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
}
