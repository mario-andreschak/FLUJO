/**
 * Persistent quality-signal cache (db/mcp-quality-cache.json), 24h TTL.
 *
 * The whole point is rate-limit conservation: a repo's stars / a package's
 * downloads are fetched at most once per day, so repeated (and unattended batch)
 * installs reuse signals and make ~zero network requests. One `QualityCache` is
 * created per orchestrator run: `load()` reads the file once into memory,
 * `get`/`set` operate in memory, and `flush()` prunes expired entries and writes
 * back once — same atomic saveItem the rest of the app uses.
 */
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { QualitySignal } from './types';

const log = createLogger('backend/services/mcp/quality/cache');

// The cache lives under its own storage key. It is not in the StorageKey enum
// (which is reserved for first-class app state); cast like the audit log does.
const CACHE_KEY = 'mcp-quality-cache' as StorageKey;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  /** Epoch ms when the signal was fetched. */
  at: number;
  signal: QualitySignal;
}

interface CacheFile {
  entries: Record<string, CacheEntry>;
}

/** Composite cache key: provider namespace + the provider's own candidate key. */
function compositeKey(providerId: string, candidateKey: string): string {
  return `${providerId}::${candidateKey}`;
}

export class QualityCache {
  private entries: Record<string, CacheEntry> = {};
  private dirty = false;
  private readonly now: number;

  /** `now` is injectable so tests are deterministic; defaults to the wall clock. */
  constructor(now: number = Date.now()) {
    this.now = now;
  }

  async load(): Promise<void> {
    try {
      const file = await loadItem<CacheFile>(CACHE_KEY, { entries: {} });
      this.entries = file?.entries && typeof file.entries === 'object' ? file.entries : {};
    } catch (error) {
      log.warn('Failed to load quality cache; starting empty', error);
      this.entries = {};
    }
  }

  /** Fresh cached signal for (provider, key), or undefined when absent/expired. */
  get(providerId: string, candidateKey: string): QualitySignal | undefined {
    const entry = this.entries[compositeKey(providerId, candidateKey)];
    if (!entry) return undefined;
    if (this.now - entry.at > CACHE_TTL_MS) return undefined;
    return entry.signal;
  }

  set(providerId: string, candidateKey: string, signal: QualitySignal): void {
    this.entries[compositeKey(providerId, candidateKey)] = { at: this.now, signal };
    this.dirty = true;
  }

  /** Prune expired entries and persist, but only if something changed. */
  async flush(): Promise<void> {
    // Drop expired entries so the file doesn't grow without bound.
    let pruned = false;
    for (const [k, entry] of Object.entries(this.entries)) {
      if (this.now - entry.at > CACHE_TTL_MS) {
        delete this.entries[k];
        pruned = true;
      }
    }
    if (!this.dirty && !pruned) return;
    try {
      await saveItem(CACHE_KEY, { entries: this.entries } satisfies CacheFile);
    } catch (error) {
      // A cache write failure must never break a search/install — it just means
      // the next run re-fetches. Log and move on.
      log.warn('Failed to persist quality cache', error);
    }
  }
}
