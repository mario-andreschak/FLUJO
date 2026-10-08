import type { MemoryItem } from '@/shared/types/enduringAgent';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Review prioritisation is intentionally separate from recall ranking.
 * Confidence is multiplied by exponential decay anchored to createdAt.
 */
export const MEMORY_REVIEW_RECENCY_HALF_LIFE_DAYS = 30;

export function memoryReviewScore(
  item: Pick<MemoryItem, 'confidence' | 'createdAt'>,
  asOf: number,
): number {
  const ageDays = Math.max(0, asOf - item.createdAt) / DAY_MS;
  const recency = 2 ** (-ageDays / MEMORY_REVIEW_RECENCY_HALF_LIFE_DAYS);
  return Math.min(1, Math.max(0, item.confidence)) * recency;
}

export function compareMemoryReviewCandidates(
  left: MemoryItem,
  right: MemoryItem,
  asOf: number,
): number {
  return memoryReviewScore(right, asOf) - memoryReviewScore(left, asOf)
    || right.createdAt - left.createdAt
    || left.id.localeCompare(right.id);
}
