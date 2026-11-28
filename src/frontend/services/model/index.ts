import { Model } from '@/shared/types';
import { ModelTestResult, NormalizedModel } from '@/shared/types/model/response';
import { createLogger } from '@/utils/logger';
import { baseRevisionHeaders, editConflictFrom, type EditConflict } from '@/frontend/services/sharedItems';
import { lazyBrowserService } from '@/frontend/services/lazyBrowserService';

const log = createLogger('frontend/services/model');

export const MODEL_CATALOG_CHANGED_EVENT = 'flujo:models-changed';

export interface ModelResult {
  success: boolean;
  model?: Model;
  error?: string;
  /** Multi-user mode (#575): someone else saved this model first; nothing was saved. */
  conflict?: EditConflict;
}

/** A failed request, with the answer the server gave. */
class ModelRequestError extends Error {
  readonly status: number;
  readonly data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'ModelRequestError';
    this.status = status;
    this.data = data;
  }
}

interface ModelsResult {
  success: boolean;
  models?: Model[];
  error?: string;
}

class ModelService {
  private notifyCatalogChanged(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(MODEL_CATALOG_CHANGED_EVENT));
  }

  private async fetchWithErrorHandling<T>(url: string, options?: RequestInit): Promise<T> {
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
        
        throw new ModelRequestError(errorMessage, response.status, data);
      }
      
      // Log success
      log.debug('API request successful', {
        url,
        method: options?.method || 'GET',
        status: response.status
      });

      return data as T;
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

  /**
   * Load models, or null when the load FAILED. Callers that must distinguish
   * "failed to load" from "no models configured" (e.g. flow validation, which
   * skips model checks on failure instead of reporting every binding as
   * deleted) use this variant.
   */
  async tryLoadModels(): Promise<Model[] | null> {
    try {
      const models = await this.fetchWithErrorHandling<Model[]>('/api/model');
      return Array.isArray(models) ? models : null;
    } catch (error) {
      log.error('Failed to load models', error);
      return null;
    }
  }

  async loadModels(): Promise<Model[]> {
    return (await this.tryLoadModels()) ?? [];
  }

  async getModel(id: string): Promise<Model | null> {
    try {
      const model = await this.fetchWithErrorHandling<Model>(`/api/model/${encodeURIComponent(id)}`);
      return model;
    } catch (error) {
      log.error('Failed to get model', { id, error });
      return null;
    }
  }

  async addModel(model: Model): Promise<ModelResult> {
    try {
      // Validate required fields
      if (!model.provider && !model.fallbackPolicy) {
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

      const newModel = await this.fetchWithErrorHandling<Model>('/api/model', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(model),
      });
      
      // Log successful addition
      log.debug('Model added successfully', { 
        modelId: newModel.id,
        displayName: newModel.displayName 
      });

      this.notifyCatalogChanged();

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

  /**
   * Multi-user mode (#575): the save names the version its editor opened
   * (registered by the model editor's edit lease). When someone else saved in
   * between, the result carries `conflict` and nothing is saved.
   */
  async updateModel(model: Model, options: { baseRevision?: string | null } = {}): Promise<ModelResult> {
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

      const updatedModel = await this.fetchWithErrorHandling<Model>(`/api/model/${encodeURIComponent(model.id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...baseRevisionHeaders('model', model.id, options.baseRevision),
        },
        body: JSON.stringify(model),
      });
      
      // Log successful update
      log.debug('Model updated successfully', { 
        modelId: model.id,
        displayName: model.displayName 
      });

      this.notifyCatalogChanged();

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

      const conflict = error instanceof ModelRequestError ? editConflictFrom(error.status, error.data) : null;
      if (conflict) return { success: false, error: conflict.message, conflict };

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

      await this.fetchWithErrorHandling(`/api/model/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      
      // Log successful deletion
      log.debug('Model deleted successfully', { 
        modelId: id,
        displayName: model.displayName 
      });

      this.notifyCatalogChanged();

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

  /**
   * Run a direct (no flow engine) connectivity test for a model. Pass an
   * existing model's id, or the fields of an unsaved draft. Returns the verbose
   * result (SDK + axios attempts and a diagnosis). Throws on transport/HTTP
   * failure of the test endpoint itself (not on a model that simply failed the
   * test — that is reported inside the result).
   */
  async testModel(params: {
    modelId?: string;
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    provider?: string;
  }): Promise<ModelTestResult> {
    log.debug('Testing model', { modelId: params.modelId, name: params.name });
    const result = await this.fetchWithErrorHandling('/api/model/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return result as ModelTestResult;
  }

  async fetchProviderModels(
    baseUrl: string,
    modelId: string,
    searchTerm?: string,
    apiKey?: string,
    profileId?: string,
    throwOnError = false,
  ): Promise<NormalizedModel[]> {
    try {
      log.debug('Fetching provider models', {
        baseUrl,
        modelId,
        searchTerm: searchTerm ? `"${searchTerm}"` : 'none',
        profileId,
        apiKey: apiKey ? 'provided' : 'not provided'
      });

      const response = await this.fetchWithErrorHandling<{ models?: NormalizedModel[] }>('/api/model/provider', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          baseUrl,
          modelId,
          searchTerm,
          profileId,
          // The key the user just typed (or a "${global:VAR}" binding). Lets us fetch the
          // provider's model list for a brand-new model WITHOUT first persisting it to disk.
          apiKey,
        }),
      });
      
      log.debug('Provider models fetched successfully', {
        baseUrl,
        modelCount: response.models?.length || 0,
        searchTerm: searchTerm ? `"${searchTerm}"` : 'none'
      });
      
      return response.models || [];
    } catch (error) {
      log.error('Failed to fetch provider models', { baseUrl, searchTerm, error });
        if (throwOnError) throw error;
      return [];
    }
  }
}

const lazyModelService = lazyBrowserService('ModelService', () => new ModelService());

export const getModelService = lazyModelService.get;
export const modelService = lazyModelService.service;
