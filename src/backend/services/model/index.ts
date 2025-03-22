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
import { mode } from 'crypto-js';

// Create a logger instance for this file
const log = createLogger('backend/services/model/index');

/**
 * ModelService class provides a clean interface for model-related operations
 * This is the core backend service that handles all model operations
 */
class ModelService {
  /**
   * Load all models from storage
   */
  async loadModels(): Promise<Model[]> {
    log.debug('loadModels: Entering method');
    try {
      const models = await loadItem<Model[]>(StorageKey.MODELS, []);
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
      
      if (model) {
        log.debug(`getModel: Model ${modelId} found`);
        return model;
      }
      
      log.debug(`getModel: Model ${modelId} not found`);
      return null;
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
      log.verbose("updateModel: full model before validation", JSON.stringify(model))
      // Validate required fields
      if (!model.id) {
        log.warn('updateModel: Missing model ID');
        return { success: false, error: 'Model ID is required' };
      }

      // Load current models
      const models = await this.loadModels();
      
      // Check if model exists
      const existingModel = models.find(m => m.id === model.id);
      if (!existingModel) {
        log.warn('updateModel: Model not found', { modelId: model.id });
        return { success: false, error: 'Model not found' };
      }

      // Validate model data
      if (!model.provider) {
        log.warn('updateModel: Missing provider', { modelId: model.id });
        return { success: false, error: 'Provider is required' };
      }

      // Check for duplicate display name (excluding the current model)
      if (model.displayName && model.displayName.trim()) {
        const normalizedDisplayName = model.displayName.trim();
        const duplicate = models.find(m => 
          m.displayName?.toLowerCase() === normalizedDisplayName.toLowerCase() && 
          m.id !== model.id
        );
        
        if (duplicate) {
          const errorMessage = `A model with the display name "${normalizedDisplayName}" already exists (ID: ${duplicate.id})`;
          log.warn('updateModel: Duplicate display name', { 
            modelId: model.id,
            displayName: normalizedDisplayName,
            duplicateId: duplicate.id,
            duplicateDisplayName: duplicate.displayName
          });
          return { 
            success: false, 
            error: errorMessage
          };
        }

        // Update display name with normalized version
        model.displayName = normalizedDisplayName;
      }
      
      // Prepare update data
      const updatedModel = {
        ...existingModel,
        ...model
      };
      
      updatedModel.ApiKey = await encryptApiKey(updatedModel.ApiKey);

      // Update all the models
      const updatedModels = models.map(m => 
        m.id === model.id ? updatedModel : m
      );
      
      // Log the update details
      log.verbose('updateModel: Updating models', JSON.stringify(updatedModel));

      // Save the changes
      await saveItem(StorageKey.MODELS, updatedModels);
      
      // Log success
      log.debug('updateModel: Model updated successfully', {
        modelId: model.id,
        displayName: updatedModel.displayName
      });
      
      return { success: true, model: updatedModel };
    } catch (error) {
      // Log detailed error
      log.error('updateModel: Failed to update model', { 
        modelId: model.id,
        displayName: model.displayName,
        error: error instanceof Error ? error.message : error
      });

      return { 
        success: false, 
        error: error instanceof Error ? 
          error.message : 
          'An unexpected error occurred while updating the model' 
      };
    }
  }

  /**
   * Delete a model by ID
   */
  async deleteModel(id: string): Promise<ModelServiceResponse> {
    log.debug('deleteModel: Entering method');
    try {
      // Validate required fields
      if (!id) {
        log.warn('deleteModel: Missing model ID');
        return { success: false, error: 'Model ID is required' };
      }

      // Load current models
      const models = await this.loadModels();

      // Check if model exists
      const existingModel = models.find(m => m.id === id);
      if (!existingModel) {
        log.warn('deleteModel: Model not found', { modelId: id });
        return { success: false, error: 'Model not found' };
      }

      // Log the delete attempt
      log.debug('deleteModel: Attempting to delete model', {
        modelId: id,
        displayName: existingModel.displayName
      });
      
      // Remove the model
      const updatedModels = models.filter(m => m.id !== id);
      await saveItem(StorageKey.MODELS, updatedModels);

      // Log successful deletion
      log.debug('deleteModel: Model deleted successfully', {
        modelId: id,
        displayName: existingModel.displayName
      });
      
      return { success: true };
    } catch (error) {
      // Log detailed error
      log.error('deleteModel: Failed to delete model', {
        modelId: id,
        error: error instanceof Error ? error.message : error
      });

      return { 
        success: false, 
        error: error instanceof Error ? 
          error.message : 
          'An unexpected error occurred while deleting the model'
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
      
      // Log success with count
      log.debug('listModels: Models loaded successfully', {
        count: models.length
      });

      return { success: true, models };
    } catch (error) {
      // Log detailed error
      log.error('listModels: Failed to list models', {
        error: error instanceof Error ? error.message : error
      });

      return {
        success: false,
        error: error instanceof Error ? 
          error.message : 
          'An unexpected error occurred while listing models'
      };
    }
  }

  /**
   * Fetch models from a provider
   * @param baseUrl The base URL of the provider
   * @param modelId Optional model ID for existing models
   */
  async fetchProviderModels(
    baseUrl: string,
    modelId?: string
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
      
      // Look up the API key for the model
      if (modelId) {
        log.debug(`Looking up API key for model ID: ${modelId}`);
        const model = await this.getModel(modelId);
        if (model) {
          log.debug(`Found model, resolving and decrypting API key`);
          // Resolve global vars and decrypt if needed

          // DO NOT REMOVE THIS LOGGING, THIS IS ON PURPOSE DURING DEVELOPMENT STAGE
          log.verbose(`!TODO:REMOVE FROM OUTPUT! - api key pre-resolve: `, JSON.stringify(model.ApiKey));
          apiKey = await resolveAndDecryptApiKey(model.ApiKey);
          log.debug(`API key successfully resolved and decrypted`);
          
          // DO NOT REMOVE THIS LOGGING, THIS IS ON PURPOSE DURING DEVELOPMENT STAGE
          log.verbose(`!TODO:REMOVE FROM OUTPUT! - api key: `, JSON.stringify(apiKey));
        } else {
          log.warn(`Model with ID ${modelId} not found for API key resolution`);
        }
      } else {
        log.error(`No API key available - modelId not provided`);
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
