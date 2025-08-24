import { createLogger } from '@/utils/logger';
import { NormalizedModel } from '@/shared/types/model/response';

const log = createLogger('backend/services/model/cache');

interface CacheEntry {
  models: NormalizedModel[];
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

/**
 * Simple in-memory cache for provider models
 * Each provider URL gets its own cache entry with TTL
 */
class ModelCache {
  private cache = new Map<string, CacheEntry>();
  private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Generate cache key from provider URL
   */
  private getCacheKey(baseUrl: string): string {
    // Normalize URL for consistent caching
    return baseUrl.toLowerCase().replace(/\/$/, '');
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
  get(baseUrl: string): NormalizedModel[] | null {
    const key = this.getCacheKey(baseUrl);
    const entry = this.cache.get(key);

    if (!entry) {
      log.debug('Cache miss - no entry found', { baseUrl, key });
      return null;
    }

    if (!this.isValid(entry)) {
      log.debug('Cache miss - entry expired', { baseUrl, key, age: Date.now() - entry.timestamp });
      this.cache.delete(key);
      return null;
    }

    log.debug('Cache hit', { baseUrl, key, modelCount: entry.models.length });
    return entry.models;
  }

  /**
   * Store models in cache for a provider
   */
  set(baseUrl: string, models: NormalizedModel[], ttl?: number): void {
    const key = this.getCacheKey(baseUrl);
    const entry: CacheEntry = {
      models,
      timestamp: Date.now(),
      ttl: ttl || this.DEFAULT_TTL
    };

    this.cache.set(key, entry);
    log.debug('Models cached', { baseUrl, key, modelCount: models.length, ttl: entry.ttl });
  }

  /**
   * Clear cache for a specific provider
   */
  clear(baseUrl: string): void {
    const key = this.getCacheKey(baseUrl);
    const deleted = this.cache.delete(key);
    log.debug('Cache cleared', { baseUrl, key, deleted });
  }

  /**
   * Clear all cached entries
   */
  clearAll(): void {
    const size = this.cache.size;
    this.cache.clear();
    log.debug('All cache cleared', { entriesCleared: size });
  }

  /**
   * Get cache statistics
   */
  getStats(): { totalEntries: number; validEntries: number; expiredEntries: number } {
    const totalEntries = this.cache.size;
    let validEntries = 0;
    let expiredEntries = 0;

    for (const entry of this.cache.values()) {
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
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of this.cache.entries()) {
      if (!this.isValid(entry)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => this.cache.delete(key));
    
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
