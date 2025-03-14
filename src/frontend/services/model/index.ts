'use client';

import { Model } from '@/shared/types/model';
import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('frontend/services/model/index');

/**
 * ModelService class provides a client-side API for UI components
 * This service makes API calls to the server-side API layer
 */
class ModelService {
  private modelsCache: Model[] | null = null;

  /**
   * Clear the models cache
   * This forces the next loadModels call to fetch fresh data
   */
  clearCache(): void {
    log.debug('clearCache: Clearing models cache');
    this.modelsCache = null;
  }

  /**
   * Load all models
   */
  async loadModels(): Promise<Model[]> {
    log.debug('loadModels: Entering method');
    try {
      // Always fetch fresh data from the API
      // This ensures we always have the most up-to-date list of models
      log.debug('loadModels: Fetching fresh data from API');
      
      // Call the API to list models
      const response = await fetch('/api/model?action=listModels');
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to load models');
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to load models');
      }
      
      const models = data.models || [];
      this.modelsCache = models;
      log.debug(`loadModels: Loaded ${models.length} models from API`);
      return models;
    } catch (error) {
      log.warn('loadModels: Failed to load models:', error);
      return [];
    }
  }

  /**
   * Get a model by ID
   */
  async getModel(modelId: string): Promise<Model | null> {
    log.debug(`getModel: Looking for model with ID: ${modelId}`);
    try {
      // Always fetch fresh data from the API
      // This ensures we always have the most up-to-date model
      log.debug(`getModel: Fetching fresh data from API for model ID: ${modelId}`);
      
      // Call the API to get the model
      const response = await fetch(`/api/model?action=getModel&id=${encodeURIComponent(modelId)}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          log.debug(`getModel: Model ${modelId} not found`);
          return null;
        }
        
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to get model: ${modelId}`);
      }
      
      const data = await response.json();
      
      if (!data.success) {
        log.debug(`getModel: Model ${modelId} not found`);
        return null;
      }
      
      log.debug(`getModel: Successfully fetched model ${modelId} from API`);
      return data.model;
    } catch (error) {
      log.error(`getModel: Error getting model ${modelId}:`, error);
      return null;
    }
  }

  /**
   * Add a new model
   */
  async addModel(model: Model): Promise<{ success: boolean; error?: string; model?: Model }> {
    log.debug('addModel: Entering method');
    try {
      // Call the API to add the model
      const response = await fetch('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'addModel',
          model
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        return { 
          success: false, 
          error: errorData.error || 'Failed to add model' 
        };
      }
      
      const data = await response.json();
      
      if (!data.success) {
        return { 
          success: false, 
          error: data.error || 'Failed to add model' 
        };
      }
      
      // Clear cache instead of updating it
      this.clearCache();
      
      return { 
        success: true,
        model: data.model
      };
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
  async updateModel(model: Model): Promise<{ success: boolean; error?: string; model?: Model }> {
    log.debug('updateModel: Entering method');
    try {
      // Call the API to update the model
      const response = await fetch('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'updateModel',
          model
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        return { 
          success: false, 
          error: errorData.error || 'Failed to update model' 
        };
      }
      
      const data = await response.json();
      
      if (!data.success) {
        return { 
          success: false, 
          error: data.error || 'Failed to update model' 
        };
      }
      
      // Clear cache instead of updating it
      this.clearCache();
      
      return { 
        success: true,
        model: data.model
      };
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
  async deleteModel(id: string): Promise<{ success: boolean; error?: string }> {
    log.debug('deleteModel: Entering method');
    try {
      // Call the API to delete the model
      const response = await fetch('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'deleteModel',
          id
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        return { 
          success: false, 
          error: errorData.error || 'Failed to delete model' 
        };
      }
      
      const data = await response.json();
      
      if (!data.success) {
        return { 
          success: false, 
          error: data.error || 'Failed to delete model' 
        };
      }
      
      // Clear cache instead of updating it
      this.clearCache();
      
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
   * Set encryption key
   */
  async setEncryptionKey(key: string): Promise<{ success: boolean; error?: string }> {
    log.debug('setEncryptionKey: Entering method');
    try {
      // Call the API to set the encryption key
      const response = await fetch('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'setEncryptionKey',
          key
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        return { 
          success: false, 
          error: errorData.error || 'Failed to set encryption key' 
        };
      }
      
      const data = await response.json();
      
      if (!data.success) {
        return { 
          success: false, 
          error: data.error || 'Failed to set encryption key' 
        };
      }
      
      return { success: true };
    } catch (error) {
      log.warn('setEncryptionKey: Failed to set encryption key:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to set encryption key' 
      };
    }
  }

  /**
   * Encrypt an API key
   */
  async encryptApiKey(apiKey: string): Promise<string | null> {
    log.debug('encryptApiKey: Entering method');
    try {
      // Handle empty API key case
      if (!apiKey || apiKey.trim() === '') {
        log.debug('encryptApiKey: Empty API key provided, returning empty string');
        return '';
      }
      
      // Call the API to encrypt the API key
      const response = await fetch('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'encryptApiKey',
          apiKey
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to encrypt API key');
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to encrypt API key');
      }
      
      return data.result;
    } catch (error) {
      log.error('encryptApiKey: Failed to encrypt API key:', error);
      return null;
    }
  }

  /**
   * Decrypt an API key for UI display
   * Note: This should only be used for UI display purposes.
   * For API calls, use the server-side API directly.
   * 
   * IMPORTANT: In line with the "always encrypted" policy, this method
   * will return asterisks for UI display instead of decrypted values.
   */
  async decryptApiKey(encryptedApiKey: string): Promise<string | null> {
    log.debug('decryptApiKey: Entering method');
    try {
      // Check if this is a global variable reference
      if (encryptedApiKey && encryptedApiKey.startsWith('${global:')) {
        // For global variables, show a placeholder in the UI
        return `Bound to global: ${encryptedApiKey.substring(9, encryptedApiKey.length - 1)}`;
      }
      
      // Check if this is a failed encryption marker
      if (encryptedApiKey && encryptedApiKey.startsWith('encrypted_failed:')) {
        // Return asterisks for security
        return '********';
      }
      
      // For security, we no longer decrypt and show API keys in the UI
      // Instead, we return asterisks to indicate the value is encrypted
      return '********';
    } catch (error) {
      log.warn('decryptApiKey: Failed to process API key:', error);
      // Return asterisks for security
      return '********';
    }
  }

  /**
   * Check if encryption is configured
   */
  async isEncryptionConfigured(): Promise<boolean> {
    log.debug('isEncryptionConfigured: Entering method');
    try {
      // Call the API to check encryption status
      const response = await fetch('/api/model?action=checkEncryption');
      
      if (!response.ok) {
        throw new Error('Failed to check encryption status');
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to check encryption status');
      }
      
      return data.initialized === true;
    } catch (error) {
      log.warn('isEncryptionConfigured: Failed to check encryption status:', error);
      return false;
    }
  }

  /**
   * Check if user encryption is enabled
   */
  async isUserEncryptionEnabled(): Promise<boolean> {
    log.debug('isUserEncryptionEnabled: Entering method');
    try {
      // Call the API to check user encryption status
      const response = await fetch('/api/model?action=checkEncryption');
      
      if (!response.ok) {
        throw new Error('Failed to check user encryption status');
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Failed to check user encryption status');
      }
      
      return data.userEncryption === true;
    } catch (error) {
      log.warn('isUserEncryptionEnabled: Failed to check user encryption status:', error);
      return false;
    }
  }

  /**
   * Generate a completion using the specified model
   */
  async generateCompletion(
    modelId: string,
    prompt: string,
    messages: any[] = []
  ): Promise<string> {
    log.debug(`generateCompletion: Generating completion with model: ${modelId}`);
    try {
      // Call the API to generate a completion
      const response = await fetch('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'generateCompletion',
          modelId,
          prompt,
          messages
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to generate completion');
      }
      
      const data = await response.json();
      log.info(`generateCompletion: Successfully generated completion with model: ${modelId}`);
      return data.content || '';
    } catch (error) {
      log.error('generateCompletion: Error generating completion:', error);
      throw new Error(`Failed to generate completion: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Fetch models from a provider
   * @param baseUrl The base URL of the provider
   * @param modelId Optional model ID for existing models
   * @param tempApiKey Optional API key for new models that don't have a modelId yet
   */
  async fetchProviderModels(baseUrl: string, modelId?: string, tempApiKey?: string): Promise<any[]> {
    log.debug(`fetchProviderModels: Fetching models for baseUrl: ${baseUrl}, modelId: ${modelId}, tempApiKey present: ${!!tempApiKey}`);
    try {
      // Build the URL with query parameters
      let url = `/api/model?action=fetchModels&baseUrl=${encodeURIComponent(baseUrl)}`;
      if (modelId) {
        url += `&modelId=${encodeURIComponent(modelId)}`;
      }
      
      // For new models, we need to pass the API key directly
      // For existing models, we use the model ID to look up the API key on the backend
      if (!modelId && tempApiKey) {
        log.debug('fetchProviderModels: Using temporary API key for new model');
        // Call the API to fetch provider models with the temporary API key
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tempApiKey
          })
        });
        
        if (!response.ok) {
          log.warn(`fetchProviderModels: Non-OK response from API: ${response.status}`);
          return []; // Return empty array instead of throwing
        }
        
        const data = await response.json();
        return data.data || [];
      } else {
        // Call the API to fetch provider models normally for existing models
        const response = await fetch(url);
        
        if (!response.ok) {
          log.warn(`fetchProviderModels: Non-OK response from API: ${response.status}`);
          return []; // Return empty array instead of throwing
        }
        
        const data = await response.json();
        return data.data || [];
      }
    } catch (error) {
      log.warn(`fetchProviderModels: Error fetching models for ${baseUrl}:`, error);
      return []; // Return empty array instead of throwing
    }
  }
}

export const modelService = new ModelService();
