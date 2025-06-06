import { createLogger } from '@/utils/logger';
import { NormalizedModel } from '@/shared/types/model/response';
import { modelService } from '@/backend/services/model';

// Create a logger instance for this file
const log = createLogger('app/api/model/backend-provider-adapter');

/**
 * Fetch models from a provider
 * This adapter delegates to the backend service
 * @param baseUrl The base URL of the provider
 * @param modelId Optional model ID for existing models
 */
export async function fetchProviderModels(
  baseUrl: string,
  modelId?: string
): Promise<NormalizedModel[]> {
  log.debug(`fetchProviderModels: Delegating to backend service for baseUrl: ${baseUrl}`);
  try {
    return await modelService.fetchProviderModels(baseUrl, modelId);
  } catch (error) {
    log.warn(`fetchProviderModels: Error fetching models for ${baseUrl}:`, error);
    // Return empty array instead of throwing to avoid UI errors
    return [];
  }
}
