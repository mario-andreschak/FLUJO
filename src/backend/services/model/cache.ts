import { createLogger } from '@/utils/logger';
import { NormalizedModel } from '@/shared/types/model/response';
import { getCurrentWorkspace } from '@/utils/workspace';

const log = createLogger('backend/services/model/cache');

interface CacheEntry {
  models: NormalizedModel[];
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

export interface ModelCacheIdentity {
  baseUrl: string;
  provider?: string;
  adapter?: string;
  profileId?: string;
  /** One-way digest only; never the credential itself. */
  credentialFingerprint?: string;
}

type ModelCacheTarget = string | ModelCacheIdentity;

/**
 * Simple in-memory cache for provider models. Workspace isolation is provided
 * by the outer map; the inner identity also separates profile, endpoint, SDK,
 * and credential without retaining plaintext credentials.
 */
class ModelCache {
  private caches = new Map<string, Map<string, CacheEntry>>();
  private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

  private currentCache(): Map<string, CacheEntry> {
    const workspace = getCurrentWorkspace();
    let cache = this.caches.get(workspace);
    if (!cache) {
      cache = new Map();
      this.caches.set(workspace, cache);
    }
    return cache;
  }

  private normalizeTarget(target: ModelCacheTarget): ModelCacheIdentity {
    return typeof target === 'string' ? { baseUrl: target } : target;
  }

  /** Generate a stable key without exposing it through logs. */
  private getCacheKey(target: ModelCacheTarget): string {
    const identity = this.normalizeTarget(target);
    const normalizedBaseUrl = identity.baseUrl.trim().toLowerCase().replace(/\/$/, '');
    return JSON.stringify([
      identity.profileId ?? '',
      identity.provider ?? '',
      identity.adapter ?? '',
      normalizedBaseUrl,
      identity.credentialFingerprint ?? '',
    ]);
  }

  private logIdentity(target: ModelCacheTarget): Omit<ModelCacheIdentity, 'credentialFingerprint'> {
    const identity = this.normalizeTarget(target);
    return {
      baseUrl: identity.baseUrl,
      ...(identity.provider ? { provider: identity.provider } : {}),
      ...(identity.adapter ? { adapter: identity.adapter } : {}),
      ...(identity.profileId ? { profileId: identity.profileId } : {}),
    };
  }

  /**
   * Check if cache entry is still valid
   */
  private isValid(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp < entry.ttl;
  }

  /**
   * Get cached models for a provider
   */
  get(target: ModelCacheTarget): NormalizedModel[] | null {
    const key = this.getCacheKey(target);
    const cache = this.currentCache();
    const entry = cache.get(key);
    const identity = this.logIdentity(target);

    if (!entry) {
      log.debug('Cache miss - no entry found', identity);
      return null;
    }

    if (!this.isValid(entry)) {
      log.debug('Cache miss - entry expired', {
        ...identity,
        age: Date.now() - entry.timestamp,
      });
      cache.delete(key);
      return null;
    }

    log.debug('Cache hit', { ...identity, modelCount: entry.models.length });
    return entry.models;
  }

  /**
   * Store models in cache for a provider
   */
  set(target: ModelCacheTarget, models: NormalizedModel[], ttl?: number): void {
    const key = this.getCacheKey(target);
    const entry: CacheEntry = {
      models,
      timestamp: Date.now(),
      ttl: ttl || this.DEFAULT_TTL
    };

    this.currentCache().set(key, entry);
    log.debug('Models cached', {
      ...this.logIdentity(target),
      modelCount: models.length,
      ttl: entry.ttl,
    });
  }

  /**
   * Clear cache for a specific provider
   */
  clear(target: ModelCacheTarget): void {
    const key = this.getCacheKey(target);
    const deleted = this.currentCache().delete(key);
    log.debug('Cache cleared', { ...this.logIdentity(target), deleted });
  }

  /**
   * Clear all cached entries
   */
  clearAll(): void {
    const cache = this.currentCache();
    const size = cache.size;
    cache.clear();
    log.debug('All cache cleared', { entriesCleared: size });
  }

  /**
   * Get cache statistics
   */
  getStats(): { totalEntries: number; validEntries: number; expiredEntries: number } {
    const cache = this.currentCache();
    const totalEntries = cache.size;
    let validEntries = 0;
    let expiredEntries = 0;

    for (const entry of cache.values()) {
      if (this.isValid(entry)) {
        validEntries++;
      } else {
        expiredEntries++;
      }
    }

    return { totalEntries, validEntries, expiredEntries };
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const cache = this.currentCache();
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of cache.entries()) {
      if (!this.isValid(entry)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => cache.delete(key));
    
    if (keysToDelete.length > 0) {
      log.debug('Cache cleanup completed', { expiredEntriesRemoved: keysToDelete.length });
    }
  }
}

// Export singleton instance
export const modelCache = new ModelCache();

/**
 * Fuzzy search implementation for filtering models
 * Supports both exact matches and fuzzy character sequence matching
 */
export function filterModels(models: NormalizedModel[], searchTerm: string): NormalizedModel[] {
  if (!searchTerm || searchTerm.trim().length === 0) {
    return models;
  }

  const normalizedSearch = searchTerm.toLowerCase().trim();
  
  return models.filter(model => {
    const modelId = model.id.toLowerCase();
    const modelName = model.name.toLowerCase();
    
    // Exact substring match gets highest priority
    if (modelId.includes(normalizedSearch) || modelName.includes(normalizedSearch)) {
      return true;
    }
    
    // Fuzzy match - check if characters appear in sequence
    const fuzzyMatch = (text: string): boolean => {
      let textIndex = 0;
      let searchIndex = 0;
      
      while (textIndex < text.length && searchIndex < normalizedSearch.length) {
        if (text[textIndex] === normalizedSearch[searchIndex]) {
          searchIndex++;
        }
        textIndex++;
      }
      
      return searchIndex === normalizedSearch.length;
    };
    
    return fuzzyMatch(modelId) || fuzzyMatch(modelName);
  }).sort((a, b) => {
    // Sort by relevance - exact matches first, then by length
    const aId = a.id.toLowerCase();
    const bId = b.id.toLowerCase();
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    
    const aExactMatch = aId.includes(normalizedSearch) || aName.includes(normalizedSearch);
    const bExactMatch = bId.includes(normalizedSearch) || bName.includes(normalizedSearch);
    
    if (aExactMatch && !bExactMatch) return -1;
    if (!aExactMatch && bExactMatch) return 1;
    
    // If both are exact matches or both are fuzzy, sort by length (shorter first)
    return a.id.length - b.id.length;
  });
}
