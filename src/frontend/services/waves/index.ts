import type { WavesResponse } from '@/shared/types/waves/waves';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/services/waves');

/**
 * Frontend service for the read-only Waves REST API (#128). Mirrors the
 * plannedExecutionsService swallow-errors-on-read pattern: a failed list
 * returns empty data so the section renders an empty state rather than crashing.
 */
class WavesService {
  async list(): Promise<WavesResponse> {
    try {
      const response = await fetch('/api/waves');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      log.warn('Failed to list waves', error);
      return { paused: false, generatedAt: new Date().toISOString(), waves: [], orphans: [] };
    }
  }
}

export const wavesService = new WavesService();
