import { createLogger } from '@/utils/logger';
import { NormalizedModel } from '@/shared/types/model/response';
import { modelService } from '@/backend/services/model';

// Create a logger instance for this file
const log = createLogger('app/api/model/provider-adapter');

/**
 * Fetch models from a provider
 * This adapter delegates to the backend service
 */
export async function fetchProviderModels(
  baseUrl: string,
  modelId?: string
): Promise<NormalizedModel[]> {
  log.debug(`fetchProviderModels: Delegating to backend service for baseUrl: ${baseUrl}`);
  try {
    return await modelService.fetchProviderModels(baseUrl, modelId);
  } catch (error) {
    log.error(`fetchProviderModels: Error fetching models for ${baseUrl}:`, error);
    throw error;
  }
}
