import { Model } from '@/shared/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/services/model');

export interface ModelResult {
  success: boolean;
  model?: Model;
  error?: string;
}

interface ModelsResult {
  success: boolean;
  models?: Model[];
  error?: string;
}

class ModelService {
  private async fetchWithErrorHandling(url: string, options?: RequestInit): Promise<any> {
    try {
      // Log request attempt
      log.debug('Making API request', { 
        url,
        method: options?.method || 'GET'
      });

      const response = await fetch(url, options);
      let data = null;
      
      try {
        // Try to parse JSON response if status is not 204
        if (response.status !== 204) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            data = await response.json();
          } else {
            // For non-JSON responses, get the text
            const text = await response.text();
            log.warn('Received non-JSON response', { 
              url, 
              contentType,
              text: text.substring(0, 200) // Log first 200 chars only
            });
            data = text;
          }
        }
      } catch (parseError) {
        log.error('Failed to parse response', { 
          url, 
          status: response.status,
          contentType: response.headers.get('content-type'),
          parseError 
        });
        throw new Error('Invalid response format');
      }
      
      if (!response.ok) {
        // For error responses, ensure we extract the error message properly
        let errorMessage: string;
        
        if (typeof data === 'object' && data !== null) {
          // Try to extract error message from common error response formats
          errorMessage = data.error || data.message || data.errorMessage || 
            JSON.stringify(data);
        } else {
          errorMessage = data || `HTTP error! status: ${response.status}`;
        }
        
        log.error('Request failed', { 
          url, 
          method: options?.method || 'GET',
          status: response.status,
          error: errorMessage,
          data 
        });
        
        throw new Error(errorMessage);
      }
      
      // Log success
      log.debug('API request successful', {
        url,
        method: options?.method || 'GET',
        status: response.status
      });

      return data;
    } catch (error) {
      // If it's a network error, provide a more user-friendly message
      if (error instanceof TypeError && error.message === 'Failed to fetch') {
        log.error('Network error', { 
          url,
          method: options?.method || 'GET',
          error 
        });
        throw new Error('Unable to connect to the server. Please check your internet connection.');
      }
      
      // If it's already an Error object with a message, rethrow it
      if (error instanceof Error) {
        throw error;
      }
      
      // Otherwise log and throw a generic error
      log.error('API request failed', { 
        url,
        method: options?.method || 'GET',
        error 
      });
      throw new Error('Failed to complete request');
    }
  }

  async loadModels(): Promise<Model[]> {
    try {
      const models = await this.fetchWithErrorHandling('/api/model');
      return models;
    } catch (error) {
      log.error('Failed to load models', error);
      return [];
    }
  }

  async getModel(id: string): Promise<Model | null> {
    try {
      const model = await this.fetchWithErrorHandling(`/api/model?id=${id}`);
      return model;
    } catch (error) {
      log.error('Failed to get model', { id, error });
      return null;
    }
  }

  async addModel(model: Model): Promise<ModelResult> {
    try {
      // Validate required fields
      if (!model.provider) {
        return {
          success: false,
          error: 'Provider is required'
        };
      }

      // Log the add attempt
      log.debug('Attempting to add model', { 
        displayName: model.displayName,
        provider: model.provider 
      });

      const newModel = await this.fetchWithErrorHandling('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'addModel',
          model
        }),
      });
      
      // Log successful addition
      log.debug('Model added successfully', { 
        modelId: newModel.id,
        displayName: newModel.displayName 
      });

      return {
        success: true,
        model: newModel,
      };
    } catch (error) {
      // Log the detailed error
      log.error('Failed to add model', { 
        displayName: model.displayName,
        provider: model.provider,
        error: error instanceof Error ? error.message : error 
      });

      // Return a user-friendly error message
      const errorMessage = error instanceof Error ? error.message : 'Failed to add model';
      
      // Handle specific error cases
      if (errorMessage.includes('display name already exists')) {
        return {
          success: false,
          error: `The display name "${model.displayName}" is already in use. Please choose a different name.`
        };
      }
      
      if (errorMessage.includes('technical name already exists')) {
        return {
          success: false,
          error: `A model with the name "${model.name}" already exists. Please choose a different name.`
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async updateModel(model: Model): Promise<ModelResult> {
    try {
      // First validate the model has required fields
      if (!model.id) {
        return {
          success: false,
          error: 'Model ID is required'
        };
      }

      // Log the update attempt
      log.debug('Attempting to update model', { 
        modelId: model.id,
        displayName: model.displayName 
      });

      const updatedModel = await this.fetchWithErrorHandling('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'updateModel',
          model: model
        }),
      });
      
      // Log successful update
      log.debug('Model updated successfully', { 
        modelId: model.id,
        displayName: model.displayName 
      });

      return {
        success: true,
        model: updatedModel,
      };
    } catch (error) {
      // Log the detailed error
      log.error('Failed to update model', { 
        modelId: model.id,
        displayName: model.displayName,
        error: error instanceof Error ? error.message : error 
      });

      // Return a user-friendly error message
      const errorMessage = error instanceof Error ? error.message : 'Failed to update model';
      
      // If it's a duplicate name error, use the backend's detailed message
      if (errorMessage.includes('display name') && errorMessage.includes('already exists')) {
        // The backend now provides a detailed message with the conflicting model ID
        return {
          success: false,
          error: errorMessage
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async deleteModel(id: string): Promise<ModelResult> {
    try {
      // Validate required fields
      if (!id) {
        return {
          success: false,
          error: 'Model ID is required'
        };
      }

      // Get model details for logging
      const model = await this.getModel(id);
      if (!model) {
        return {
          success: false,
          error: 'Model not found'
        };
      }

      // Log the delete attempt
      log.debug('Attempting to delete model', { 
        modelId: id,
        displayName: model.displayName 
      });

      await this.fetchWithErrorHandling('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'deleteModel',
          id
        }),
      });
      
      // Log successful deletion
      log.debug('Model deleted successfully', { 
        modelId: id,
        displayName: model.displayName 
      });

      return { success: true };
    } catch (error) {
      // Get model details for error logging if possible
      let displayName: string | undefined;
      try {
        const model = await this.getModel(id);
        displayName = model?.displayName;
      } catch {
        // Ignore error from getModel
      }

      // Log the detailed error
      log.error('Failed to delete model', { 
        modelId: id,
        displayName,
        error: error instanceof Error ? error.message : error 
      });

      // Return a user-friendly error message
      const errorMessage = error instanceof Error ? error.message : 'Failed to delete model';

      // Handle specific error cases
      if (errorMessage.includes('not found')) {
        return {
          success: false,
          error: 'The model no longer exists or has already been deleted'
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async updateModelApiKey(modelId: Model["id"], newApiKey: string): Promise<ModelResult> {
    try {
      const model = await this.getModel(modelId);
      
      if (!model) {
        return {
          success: false,
          error: 'Model not found',
        };
      }

      const result = await this.updateModel({...model,ApiKey:newApiKey});

      return result;
    } catch (error) {
      log.error('Failed to update model API key', { modelId, error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update API key',
      };
    }
  }

  async fetchProviderModels(baseUrl: string, modelId: string): Promise<Array<{id: string, name: string, description?: string}>> {
    try {
      const response = await this.fetchWithErrorHandling('/api/model/provider', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          baseUrl,
          modelId,
        }),
      });
      
      return response.models || [];
    } catch (error) {
      log.error('Failed to fetch provider models', { baseUrl, error });
      return [];
    }
  }
}

export const modelService = new ModelService();
