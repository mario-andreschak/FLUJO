/** Tracks whole assertions so their awaited guards cannot survive unlock. */
export function createHeldReadScope() {
  let active = true;
  const pending = new Set<Promise<unknown>>();
  const assertActive = () => {
    if (!active) throw new Error('Held read callback scope ended.');
  };
  return {
    assertActive,
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = (async () => {
        assertActive();
        const value = await operation();
        assertActive();
        return value;
      })();
      pending.add(result);
      void result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    },
    async close(): Promise<void> {
      active = false;
      await Promise.allSettled([...pending]);
    },
  };
}
