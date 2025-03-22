import { createLogger } from '@/utils/logger';
import { Model } from '@/shared/types/model';
import { 
  ModelServiceResponse, 
  ModelOperationResponse, 
  ModelListResponse,
} from '@/shared/types/model/response';
import { modelService } from '@/backend/services/model';

// Create a logger instance for this file
const log = createLogger('app/api/model/model-adapter');

/**
 * Sanitize a model object before sending it to the frontend
 * This ensures sensitive data like API keys are never sent to the client
 */
function sanitizeModelForFrontend(model: Model): Model {
  // Create a copy to avoid modifying the original
  const sanitizedModel = { ...model };
  
  // Replace the API key with a placeholder
  if (sanitizedModel.ApiKey) {
    sanitizedModel.ApiKey = '********';
  }
  
  return sanitizedModel;
}

/**
 * Load all models
 * This adapter delegates to the backend service
 */
export async function loadModels(): Promise<ModelListResponse> {
  log.debug('loadModels: Delegating to backend service');
  const result = await modelService.listModels();
  
  // Sanitize models before sending to frontend
  if (result.success && result.models) {
    result.models = result.models.map(sanitizeModelForFrontend);
  }
  
  return result;
}

/**
 * Get a model by ID
 * This adapter delegates to the backend service
 */
export async function getModel(modelId: string): Promise<ModelOperationResponse> {
  log.debug(`getModel: Delegating to backend service for model ID: ${modelId}`);
  try {
    const model = await modelService.getModel(modelId);
    if (!model) {
      return { success: false, error: `Model not found: ${modelId}` };
    }
    
    // Sanitize model before sending to frontend
    return { success: true, model: sanitizeModelForFrontend(model) };
  } catch (error) {
    log.error(`getModel: Error getting model ${modelId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get model'
    };
  }
}

/**
 * Add a new model
 * This adapter delegates to the backend service
 */
export async function addModel(model: Model): Promise<ModelOperationResponse> {
  log.debug('addModel: Delegating to backend service');
  const result = await modelService.addModel(model);
  
  // Sanitize model before sending to frontend
  if (result.success && result.model) {
    result.model = sanitizeModelForFrontend(result.model);
  }
  
  return result;
}

/**
 * Update an existing model
 * This adapter delegates to the backend service
 */
export async function updateModel(model: Model): Promise<ModelOperationResponse> {
  log.debug('updateModel: Delegating to backend service');
  const result = await modelService.updateModel(model);
  
  // Sanitize model before sending to frontend
  if (result.success && result.model) {
    result.model = sanitizeModelForFrontend(result.model);
  }
  
  return result;
}

/**
 * Delete a model by ID
 * This adapter delegates to the backend service
 */
export async function deleteModel(id: string): Promise<ModelServiceResponse> {
  log.debug('deleteModel: Delegating to backend service');
  return modelService.deleteModel(id);
}

/**
 * Set encryption key
 * This adapter delegates to the backend service
 */
export async function setEncryptionKey(key: string): Promise<ModelServiceResponse> {
  log.debug('setEncryptionKey: Delegating to backend service');
  return modelService.setEncryptionKey(key);
}

/**
 * Encrypt an API key
 * This adapter delegates to the backend service
 */
export async function encryptApiKey(apiKey: string): Promise<string | null> {
  log.debug('encryptApiKey: Delegating to backend service');
  return modelService.encryptApiKey(apiKey);
}

/**
 * Check if encryption is configured
 * This adapter delegates to the backend service
 */
export async function isEncryptionConfigured(): Promise<boolean> {
  log.debug('isEncryptionConfigured: Delegating to backend service');
  return modelService.isEncryptionConfigured();
}

/**
 * Check if user encryption is enabled
 * This adapter delegates to the backend service
 */
export async function isUserEncryptionEnabled(): Promise<boolean> {
  log.debug('isUserEncryptionEnabled: Delegating to backend service');
  return modelService.isUserEncryptionEnabled();
}
