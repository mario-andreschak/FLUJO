/**
 * Pure sort/grouping helpers for the Models list surface (#80).
 *
 * Kept free of React/MUI so the sort comparator and the sort-derived bucketing
 * can be unit-tested in isolation (mirrors how the Flow dashboard folds by the
 * active sort key via the shared `cardGrouping` primitives).
 */
import { Model } from '@/shared/types';
import { getProviderProfile } from '@/shared/types/model/provider';
import { alphaBucket } from '@/utils/shared/cardGrouping';

/** Sort keys for the Models surface. No date sort: the Model type has no timestamp. */
export type ModelSortOption = 'name-asc' | 'name-desc' | 'provider' | 'context-desc' | 'context-asc';

export const MODEL_SORT_LABELS: Record<ModelSortOption, string> = {
  'name-asc': 'Name (A-Z)',
  'name-desc': 'Name (Z-A)',
  'provider': 'Provider',
  'context-desc': 'Context (largest)',
  'context-asc': 'Context (smallest)',
};

/** Display name shown/sorted on a model card (falls back to the technical name). */
export const modelDisplayName = (m: Model): string => m.displayName || m.name || '';
/** Human-readable provider label (resolves adapter/provider fallbacks). */
export const modelProviderLabel = (m: Model): string => getProviderProfile(m.provider, m.adapter).label;

/**
 * Context-window size band used when folding "By sort" on a context sort. Models
 * without a numeric context window fall into a single "Unknown" bucket.
 */
export function bucketContextWindow(contextWindow: number | undefined): { key: string; label: string } {
  if (typeof contextWindow !== 'number' || Number.isNaN(contextWindow)) {
    return { key: 'ctx:unknown', label: 'Unknown context' };
  }
  if (contextWindow <= 8_000) return { key: 'ctx:<=8k', label: '≤ 8K tokens' };
  if (contextWindow <= 32_000) return { key: 'ctx:8k-32k', label: '8K–32K tokens' };
  if (contextWindow <= 128_000) return { key: 'ctx:32k-128k', label: '32K–128K tokens' };
  if (contextWindow <= 1_000_000) return { key: 'ctx:128k-1m', label: '128K–1M tokens' };
  return { key: 'ctx:>1m', label: '> 1M tokens' };
}

/**
 * Map the active sort key to a group bucket for a model. Alphabetical sorts fold
 * by first letter; provider sort folds by provider label; context sorts fold by
 * size band.
 */
export function deriveModelSortGroup(model: Model, sortOption: ModelSortOption): { key: string; label: string } {
  switch (sortOption) {
    case 'provider': {
      const label = modelProviderLabel(model);
      return { key: `provider:${label}`, label };
    }
    case 'context-asc':
    case 'context-desc':
      return bucketContextWindow(model.contextWindow);
    case 'name-asc':
    case 'name-desc':
    default:
      return alphaBucket(modelDisplayName(model));
  }
}

/**
 * Comparator for the active sort key. Undefined context windows always sort
 * last (regardless of direction); ties fall back to the display name A–Z so the
 * order is stable.
 */
export function compareModels(sortOption: ModelSortOption): (a: Model, b: Model) => number {
  return (a, b) => {
    switch (sortOption) {
      case 'name-asc':
        return modelDisplayName(a).localeCompare(modelDisplayName(b));
      case 'name-desc':
        return modelDisplayName(b).localeCompare(modelDisplayName(a));
      case 'provider':
        return modelProviderLabel(a).localeCompare(modelProviderLabel(b)) ||
          modelDisplayName(a).localeCompare(modelDisplayName(b));
      case 'context-desc':
      case 'context-asc': {
        const av = typeof a.contextWindow === 'number' && !Number.isNaN(a.contextWindow) ? a.contextWindow : undefined;
        const bv = typeof b.contextWindow === 'number' && !Number.isNaN(b.contextWindow) ? b.contextWindow : undefined;
        if (av === undefined && bv === undefined) return modelDisplayName(a).localeCompare(modelDisplayName(b));
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        const diff = sortOption === 'context-desc' ? bv - av : av - bv;
        return diff !== 0 ? diff : modelDisplayName(a).localeCompare(modelDisplayName(b));
      }
      default:
        return 0;
    }
  };
}

/** Sort a copy of `models` by the active sort key, leaving the input untouched. */
export function sortModels(models: Model[], sortOption: ModelSortOption): Model[] {
  return [...models].sort(compareModels(sortOption));
}
