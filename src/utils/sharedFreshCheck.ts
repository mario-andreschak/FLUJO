/**
 * Callers that ask the same question while it is being checked share the next
 * check, which starts once the running one has ended, so after each of them
 * asked. No caller gets an answer older than its question, and any number of
 * callers asking at once cause at most two checks in a row instead of one
 * each (#757: a burst of 300 chats repeated the same file checks hundreds of
 * times at once). Nothing is kept after a check ends.
 */
export class SharedFreshChecks<T> {
  private readonly checks = new Map<string, { running: Promise<T>; next?: Promise<T> }>();

  run(key: string, check: () => Promise<T>): Promise<T> {
    const entry = this.checks.get(key);
    if (!entry) return this.start(key, check);
    entry.next ??= entry.running.then(noop, noop).then(() => this.start(key, check));
    return entry.next;
  }

  private start(key: string, check: () => Promise<T>): Promise<T> {
    // A queued next check replaces this entry when it starts.
    const running: Promise<T> = Promise.resolve().then(check).finally(() => {
      const entry = this.checks.get(key);
      if (entry?.running === running && !entry.next) this.checks.delete(key);
    });
    this.checks.set(key, { running });
    return running;
  }
}

function noop(): void {}

/** One shared check without keys, for a single resource such as one lock file. */
export function sharedFreshCheck<T>(check: () => Promise<T>): () => Promise<T> {
  const checks = new SharedFreshChecks<T>();
  return () => checks.run('', check);
}
