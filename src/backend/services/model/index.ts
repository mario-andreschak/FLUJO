import { Model } from '@/shared/types/model';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { 
  ModelServiceResponse, 
  ModelOperationResponse, 
  ModelListResponse,
  CompletionResponse,
  NormalizedModel
} from '@/shared/types/model/response';
import { ModelProvider } from '@/shared/types/model/provider';
import { 
  encryptApiKey, 
  decryptApiKey, 
  resolveAndDecryptApiKey,
  isEncryptionConfigured,
  isUserEncryptionEnabled,
  setEncryptionKey,
  initializeDefaultEncryption
} from './encryption';
import { 
  fetchModelsFromProvider,
  getProviderFromBaseUrl
} from './provider';

// Create a logger instance for this file
const log = createLogger('backend/services/model/index');

/**
 * ModelService class provides a clean interface for model-related operations
 * This is the core backend service that handles all model operations
 */
class ModelService {
  private modelsCache: Model[] | null = null;

  /**
   * Load all models from storage
   */
  async loadModels(): Promise<Model[]> {
    log.debug('loadModels: Entering method');
    try {
      // Try to use cache first
      if (this.modelsCache) {
        return this.modelsCache;
      }

      const models = await loadItem<Model[]>(StorageKey.MODELS, []);
      this.modelsCache = models;
      return models;
    } catch (error) {
      log.warn('loadModels: Failed to load models:', error);
      return [];
    }
  }

  /**
   * Get a specific model by ID
   */
  async getModel(modelId: string): Promise<Model | null> {
    log.debug(`getModel: Looking for model with ID: ${modelId}`);
    try {
      const models = await this.loadModels();
      const model = models.find(model => model.id === modelId) || null;
      log.debug(`getModel: Model ${modelId} ${model ? 'found' : 'not found'}`);
      return model;
    } catch (error) {
      log.error(`getModel: Error finding model ${modelId}:`, error);
      return null;
    }
  }

  /**
   * Add a new model
   */
  async addModel(model: Model): Promise<ModelOperationResponse> {
    log.debug('addModel: Entering method');
    try {
      // Load current models
      const models = await this.loadModels();
      
      // Check for duplicate name (technical name)
      if (models.some(m => m.name === model.name)) {
        return { success: false, error: 'A model with this technical name already exists' };
      }
      
      // Check for duplicate display name if provided
      if (model.displayName && models.some(m => m.displayName === model.displayName)) {
        return { success: false, error: 'A model with this display name already exists' };
      }
      
      // Add the new model
      const updatedModels = [...models, model];
      await saveItem(StorageKey.MODELS, updatedModels);
      
      // Clear cache instead of updating it
      this.modelsCache = null;
      
      return { success: true, model };
    } catch (error) {
      log.warn('addModel: Failed to add model:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to add model' 
      };
    }
  }

  /**
   * Update an existing model
   */
  async updateModel(model: Model): Promise<ModelOperationResponse> {
    log.debug('updateModel: Entering method');
    try {
      // Load current models
      const models = await this.loadModels();
      
      // Check for duplicate technical name (excluding the current model)
      if (models.some(m => m.name === model.name && m.id !== model.id)) {
        return { success: false, error: 'A model with this technical name already exists' };
      }
      
      // Check for duplicate display name (excluding the current model)
      if (model.displayName && models.some(m => m.displayName === model.displayName && m.id !== model.id)) {
        return { success: false, error: 'A model with this display name already exists' };
      }
      
      // Update the model
      const updatedModels = models.map(m => m.id === model.id ? model : m);
      await saveItem(StorageKey.MODELS, updatedModels);
      
      // Clear cache instead of updating it
      this.modelsCache = null;
      
      return { success: true, model };
    } catch (error) {
      log.warn('updateModel: Failed to update model:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to update model' 
      };
    }
  }

  /**
   * Delete a model by ID
   */
  async deleteModel(id: string): Promise<ModelServiceResponse> {
    log.debug('deleteModel: Entering method');
    try {
      // Load current models
      const models = await this.loadModels();
      
      // Remove the model
      const updatedModels = models.filter(m => m.id !== id);
      await saveItem(StorageKey.MODELS, updatedModels);
      
      // Clear cache instead of updating it
      this.modelsCache = null;
      
      return { success: true };
    } catch (error) {
      log.warn('deleteModel: Failed to delete model:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to delete model' 
      };
    }
  }

  /**
   * List all models
   */
  async listModels(): Promise<ModelListResponse> {
    log.debug('listModels: Entering method');
    try {
      const models = await this.loadModels();
      return { success: true, models };
    } catch (error) {
      log.warn('listModels: Failed to list models:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list models'
      };
    }
  }

  /**
   * Fetch models from a provider
   * @param baseUrl The base URL of the provider
   * @param modelId Optional model ID for existing models
   * @param tempApiKey Optional API key for new models that don't have a modelId yet
   */
  async fetchProviderModels(
    baseUrl: string,
    modelId?: string,
    tempApiKey?: string
  ): Promise<NormalizedModel[]> {
    log.debug(`fetchProviderModels: Fetching models for baseUrl: ${baseUrl}`);
    try {
      // Determine provider from model or baseUrl
      let provider: ModelProvider;
      
      if (modelId) {
        log.debug(`Looking up model with ID: ${modelId}`);
        const models = await this.loadModels();
        const model = models.find(m => m.id === modelId);
        
        if (model && model.provider) {
          // Use the stored provider if available
          provider = model.provider;
          log.debug(`Using stored provider: ${provider}`);
        } else {
          // Fall back to URL-based detection
          provider = getProviderFromBaseUrl(baseUrl);
          log.debug(`Provider determined from URL as: ${provider}`);
        }
      } else {
        // For new models, determine provider from baseUrl
        provider = getProviderFromBaseUrl(baseUrl);
        log.debug(`Provider determined from URL as: ${provider}`);
      }
      
      // Determine the API key to use
      let apiKey = null;
      
      // If a temporary API key is provided (for new models), use it directly
      if (tempApiKey) {
        log.debug('Using temporary API key for new model');
        apiKey = tempApiKey;
      } 
      // Otherwise, if we have a modelId, look up the API key for that model
      else if (modelId) {
        log.debug(`Looking up API key for model ID: ${modelId}`);
        const models = await this.loadModels();
        const model = models.find(m => m.id === modelId);
        if (model) {
          log.debug(`Found model, resolving and decrypting API key`);
          // Resolve global vars and decrypt if needed
          apiKey = await resolveAndDecryptApiKey(model.encryptedApiKey);
          log.debug(`API key successfully resolved and decrypted`);
        } else {
          log.warn(`Model with ID ${modelId} not found for API key resolution`);
        }
      } else {
        log.error(`No API key available - neither modelId nor tempApiKey provided`);
      }
      
      // Fetch models based on provider
      log.info(`Fetching models from provider: ${provider}`);
      const models = await fetchModelsFromProvider(provider, baseUrl, apiKey);
      log.debug(`Successfully fetched ${models.length} models from provider`);
      return models;
    } catch (error) {
      log.error(`fetchProviderModels: Error fetching models for ${baseUrl}:`, error);
      throw error;
    }
  }


  // Re-export encryption methods for convenience
  encryptApiKey = encryptApiKey;
  decryptApiKey = decryptApiKey;
  resolveAndDecryptApiKey = resolveAndDecryptApiKey;
  isEncryptionConfigured = isEncryptionConfigured;
  isUserEncryptionEnabled = isUserEncryptionEnabled;
  setEncryptionKey = setEncryptionKey;
  initializeDefaultEncryption = initializeDefaultEncryption;
}

// Export a singleton instance of the service
export const modelService = new ModelService();
