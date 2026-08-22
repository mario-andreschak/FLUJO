/**
 * Memory settings service: cached retrieval and persistence of workspace-scoped memory lifecycle configuration.
 * Pattern mirrors RunResourceSettings (src/backend/services/runResources/index.ts L125-142).
 *
 * Issue #452: Candidate lifecycle, auto-consolidation, and conflict surfacing.
 */

import { createLogger } from '@/utils/logger';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { workspaceCacheKey } from '@/utils/workspace';
import {
  DEFAULT_MEMORY_SETTINGS,
  type MemorySettings,
  mergeMemorySettings,
} from '@/shared/types/memorySettings';
import { StorageKey } from '@/shared/types/storage/storage';

const log = createLogger('backend/services/enduringAgents/memorySettings');

// Cache: workspace-local (workspaceCacheKey) + global Map
const SETTINGS_TTL_MS = 60_000; // 1 minute
declare global {
  var __flujo_memory_settings_cache: Map<string, { value: Required<MemorySettings>; at: number }> | undefined;
}
const settingsCache: Map<string, { value: Required<MemorySettings>; at: number }> =
  global.__flujo_memory_settings_cache ??
  (global.__flujo_memory_settings_cache = new Map());

/**
 * Get workspace-scoped memory settings with in-process caching (TTL 1 minute).
 * Merges stored settings with defaults, returning a complete settings object.
 * @returns Merged MemorySettings with all fields populated
 */
export async function getMemorySettings(): Promise<Required<MemorySettings>> {
  const settingsKey = workspaceCacheKey('memory-settings');
  const cached = settingsCache.get(settingsKey);
  if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) {
    return cached.value;
  }

  let value: Required<MemorySettings>;
  try {
    const stored = await loadItem<Partial<MemorySettings>>(
      StorageKey.MEMORY_SETTINGS,
      {},
    );
    value = mergeMemorySettings(stored ?? undefined);
  } catch (error) {
    log.warn('Failed to load memory settings; using defaults.', { error });
    value = { ...DEFAULT_MEMORY_SETTINGS };
  }

  settingsCache.set(settingsKey, { value, at: Date.now() });
  return value;
}

/**
 * Update workspace-scoped memory settings and invalidate cache.
 * @param updates Partial settings object; only specified fields are updated, others are preserved
 */
export async function setMemorySettings(updates: Partial<MemorySettings>): Promise<void> {
  try {
    const current = await getMemorySettings();
    const merged = mergeMemorySettings({ ...current, ...updates });
    await saveItem(StorageKey.MEMORY_SETTINGS, merged);
    // Invalidate cache to force reload on next access
    const settingsKey = workspaceCacheKey('memory-settings');
    settingsCache.delete(settingsKey);
    log.info('Memory settings updated.', { updates });
  } catch (error) {
    log.error('Failed to update memory settings.', { error, updates });
    throw error;
  }
}

/**
 * Invalidate the settings cache (used by tests and admin operations).
 */
export function invalidateMemorySettingsCache(): void {
  const settingsKey = workspaceCacheKey('memory-settings');
  settingsCache.delete(settingsKey);
}
