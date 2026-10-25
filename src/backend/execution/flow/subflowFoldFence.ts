/** A failed acknowledgement may follow an actual snapshot commit. Until a
 * durable read resolves that ambiguity, no ordinary error/checkpoint write may
 * overwrite the winning fold with the older live state. Runtime-only fence. */
const globalFences = globalThis as typeof globalThis & { __flujoSubflowFoldFences?: WeakMap<object, () => Promise<void>> };
const pending = globalFences.__flujoSubflowFoldFences ??= new WeakMap<object, () => Promise<void>>();
export function fenceSubflowFold(state: object, reconcile: () => Promise<void>): void { pending.set(state, reconcile); }
export function clearSubflowFoldFence(state: object): void { pending.delete(state); }
export async function reconcileSubflowFold(state: object): Promise<boolean> {
  const reconcile = pending.get(state);
  if (!reconcile) return false;
  await reconcile();
  if (pending.get(state) === reconcile) pending.delete(state);
  return true;
}
