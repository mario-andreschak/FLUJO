/**
 * Ids of conversations that exist only in this browser so far (a split that
 * has not been sent yet). The sidebar shows how many there are, so the set
 * tells React when it changes (`subscribe` / `size` for useSyncExternalStore).
 */
export class LocalOnlyConversationIds {
  private readonly ids = new Set<string>();
  private readonly listeners = new Set<() => void>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.notify();
  }

  /** Returns whether the id was there. */
  delete(id: string): boolean {
    const removed = this.ids.delete(id);
    if (removed) this.notify();
    return removed;
  }

  get size(): number {
    return this.ids.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
