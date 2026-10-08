import type { AutomationMapResponse } from '@/shared/types/waves/automationMap';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/services/automationMap');

/** Read-only client for the unified Automation Playground graph. */
class AutomationMapService {
  async load(): Promise<AutomationMapResponse> {
    try {
      const response = await fetch('/api/automation-map');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as AutomationMapResponse;
    } catch (error) {
      log.warn('Failed to load automation map', error);
      throw error;
    }
  }
}

export const automationMapService = new AutomationMapService();
