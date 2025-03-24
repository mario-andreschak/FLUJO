import { createLogger } from '@/utils/logger';
import { Model } from '@/shared/types/model';
import * as modelAdapter from './frontend-model-adapter';

// Create a logger instance for this file
const log = createLogger('app/api/model/backed-model-adapter');

/**
 * Server-side adapter for model operations
 * This adapter is used by server components to access model data
 * while maintaining the clean architecture pattern
 */

/**
 * Load all models
 * This adapter delegates to the model adapter
 */
export async function loadModels(): Promise<Model[]> {
  log.debug('loadModels: Delegating to model adapter');
  const result = await modelAdapter.loadModels();
  
  if (!result.success || !result.models) {
    log.warn('loadModels: Failed to load models', { error: result.error });
    return [];
  }
  
  return result.models;
}

/**
 * Get a model by ID
 * This adapter delegates to the model adapter
 */
export async function getModel(modelId: string): Promise<Model | null> {
  log.debug(`getModel: Delegating to model adapter for model ID: ${modelId}`);
  const result = await modelAdapter.getModel(modelId);
  
  if (!result.success || !result.model) {
    log.warn(`getModel: Failed to get model ${modelId}`, { error: result.error });
    return null;
  }
  
  return result.model;
}
