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
import { MASKED_API_KEY } from '@/shared/types/constants';
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
import { modelCache, filterModels } from './cache';
import { testModelConnection } from './testConnection';
import { ModelTestResult } from '@/shared/types/model/response';

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

      // Encrypt the API key before persisting. A brand-new model's first save arrives here
      // with the plaintext key the user typed (or a "${global:VAR}" binding), so this is the
      // point that prevents an unencrypted key from being written to disk.
      const modelToSave: Model = {
        ...model,
        ApiKey: await this.resolveApiKeyForSave(model.ApiKey, undefined)
      };

      // Add the new model
      const updatedModels = [...models, modelToSave];
      await saveItem(StorageKey.MODELS, updatedModels);

      return { success: true, model: modelToSave };
    } catch (error) {
      log.warn('addModel: Failed to add model:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to add model' 
      };
    }
  }

  /**
   * Decide what to persist for a model's API key on save.
   *
   * The frontend never holds the real key (the API adapter masks it), so it cannot send it
   * back. This resolves the incoming value against the existing stored key:
   *   - masked placeholder  -> keep the existing stored key unchanged (the key was not edited)
   *   - "${global:VAR}"      -> store the reference verbatim; it is not a secret and is
   *                             resolved+decrypted on demand at use time
   *   - already encrypted    -> store as-is (idempotent; avoids double-encryption)
   *   - empty                -> store empty (key explicitly cleared)
   *   - anything else        -> a freshly typed plaintext key; encrypt it
   *
   * This is the single authoritative place that prevents the masked placeholder from ever
   * overwriting (and destroying) a real stored key.
   */
  private async resolveApiKeyForSave(incomingApiKey: string | undefined, existingApiKey: string | undefined): Promise<string> {
    const incoming = incomingApiKey ?? '';

    if (incoming === MASKED_API_KEY) {
      return existingApiKey ?? '';
    }
    if (incoming.startsWith('${global:')) {
      return incoming;
    }
    if (incoming.startsWith('encrypted:') || incoming.startsWith('encrypted_failed:')) {
      return incoming;
    }
    if (incoming.trim() === '') {
      return '';
    }
    return await encryptApiKey(incoming);
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

      // Resolve the API key against the existing stored value. Critically, a masked
      // placeholder coming from the frontend means "unchanged" and must preserve the
      // existing key rather than be encrypted on top of it.
      updatedModel.ApiKey = await this.resolveApiKeyForSave(model.ApiKey, existingModel.ApiKey);

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
   * Fetch models from a provider with caching and optional search filtering
   * @param baseUrl The base URL of the provider
   * @param modelId Optional model ID for existing models
   * @param searchTerm Optional search term to filter models
   */
  async fetchProviderModels(
    baseUrl: string,
    modelId?: string,
    searchTerm?: string,
    apiKey?: string
  ): Promise<NormalizedModel[]> {
    log.debug(`fetchProviderModels: Fetching models for baseUrl: ${baseUrl}`, {
      modelId,
      hasApiKey: Boolean(apiKey),
      searchTerm: searchTerm ? `"${searchTerm}"` : 'none'
    });
    
    try {
      // Check cache first
      let allModels = modelCache.get(baseUrl);
      
      if (allModels) {
        log.debug('Using cached models', { count: allModels.length });
      } else {
        log.debug('Cache miss - fetching from provider');
        
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
        
        // Determine the API key to use. Prefer a directly-supplied key (the value the user
        // just typed, or a "${global:VAR}" binding) so a brand-new model can list provider
        // models WITHOUT being persisted to disk first. Fall back to the stored key of an
        // existing model looked up by id.
        let resolvedApiKey: string | null = null;

        if (apiKey && apiKey !== MASKED_API_KEY) {
          // resolveAndDecryptApiKey transparently handles plaintext, "${global:VAR}"
          // references, and "encrypted:" values.
          resolvedApiKey = await resolveAndDecryptApiKey(apiKey);
          log.debug('Using directly-supplied API key for provider fetch');
        } else if (modelId) {
          log.debug(`Looking up stored API key for model ID: ${modelId}`);
          const model = await this.getModel(modelId);
          if (model) {
            resolvedApiKey = await resolveAndDecryptApiKey(model.ApiKey);
            log.debug('Resolved stored API key for provider fetch');
          } else {
            log.warn(`Model with ID ${modelId} not found for API key resolution`);
          }
        } else {
          log.warn('No API key supplied and no modelId provided - provider fetch will be unauthenticated');
        }

        // Fetch models from provider
        log.info(`Fetching models from provider: ${provider}`);
        allModels = await fetchModelsFromProvider(provider, baseUrl, resolvedApiKey);
        log.debug(`Successfully fetched ${allModels.length} models from provider`);
        
        // Cache the results
        modelCache.set(baseUrl, allModels);
      }
      
      // Apply search filtering if provided
      if (searchTerm && searchTerm.trim()) {
        const filteredModels = filterModels(allModels, searchTerm);
        log.debug(`Search filtering applied`, { 
          searchTerm: `"${searchTerm}"`, 
          originalCount: allModels.length, 
          filteredCount: filteredModels.length 
        });
        return filteredModels;
      }
      
      return allModels;
    } catch (error) {
      log.error(`fetchProviderModels: Error fetching models for ${baseUrl}:`, error);
      throw error;
    }
  }


  /**
   * Run a direct, flow-engine-free connectivity test for a model.
   *
   * Resolution mirrors fetchProviderModels: prefer a directly-supplied key (the
   * value the user just typed, or a "${global:VAR}" binding) so a brand-new,
   * unsaved model can be tested; otherwise fall back to the stored key of an
   * existing model looked up by id. The decrypted key never leaves the backend.
   */
  async testModel(params: {
    modelId?: string;
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    provider?: ModelProvider;
  }): Promise<ModelTestResult> {
    const { modelId, apiKey } = params;

    let modelName = params.name;
    let baseUrl = params.baseUrl;
    let provider = params.provider;
    let resolvedApiKey: string | null = null;

    if (apiKey && apiKey !== MASKED_API_KEY) {
      resolvedApiKey = await resolveAndDecryptApiKey(apiKey);
    }

    // Fill in any missing fields (and the key, if no usable one was supplied)
    // from the stored model record.
    if (modelId) {
      const stored = await this.getModel(modelId);
      if (stored) {
        modelName = modelName || stored.name;
        baseUrl = baseUrl || stored.baseUrl;
        provider = provider || stored.provider;
        if (!resolvedApiKey) {
          resolvedApiKey = await resolveAndDecryptApiKey(stored.ApiKey);
        }
      }
    }

    if (!modelName) {
      throw new Error('Model name is required to run a test');
    }
    if (!resolvedApiKey) {
      throw new Error('Could not resolve an API key for this model');
    }

    return testModelConnection({
      modelName,
      baseUrl,
      apiKey: resolvedApiKey,
      provider,
    });
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
