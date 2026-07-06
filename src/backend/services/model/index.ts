import OpenAI from 'openai';
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
import { ModelProvider, ModelAdapter } from '@/shared/types/model/provider';
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
import { getCompletionAdapter } from './adapters';

/**
 * Result of a direct (single-turn) chat completion through ModelService.
 * On failure the error carries only sanitized, client-safe fields — the raw
 * provider body (which can echo request headers) is never passed through.
 */
export type DirectCompletionResult =
  | { success: true; completion: OpenAI.Chat.Completions.ChatCompletion }
  | {
      success: false;
      error: { message: string; type: string; code: string; param?: string | null };
      statusCode: number;
    };

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

      // Duplicate detection is by DISPLAY name only (case-insensitive). The technical
      // `name` is the provider's model id and is intentionally allowed to repeat — e.g.
      // two entries both pointing at "openrouter/auto" but distinguished by display name
      // (and possibly different keys, temperature, or prompt template). The display name
      // is what the UI shows and what a flow's process node surfaces, so that is the field
      // that must be unique. Mirrors updateModel's check.
      if (model.displayName && model.displayName.trim()) {
        const normalizedDisplayName = model.displayName.trim();
        const duplicate = models.find(
          m => m.displayName?.toLowerCase() === normalizedDisplayName.toLowerCase()
        );
        if (duplicate) {
          return { success: false, error: `A model with the display name "${normalizedDisplayName}" already exists` };
        }
        model.displayName = normalizedDisplayName;
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
    adapter?: ModelAdapter;
  }): Promise<ModelTestResult> {
    const { modelId, apiKey } = params;

    let modelName = params.name;
    let baseUrl = params.baseUrl;
    let provider = params.provider;
    let adapter = params.adapter;
    let storedModel: Model | null = null;
    let resolvedApiKey: string | null = null;

    if (apiKey && apiKey !== MASKED_API_KEY) {
      resolvedApiKey = await resolveAndDecryptApiKey(apiKey);
    }

    // Fill in any missing fields (and the key, if no usable one was supplied)
    // from the stored model record.
    if (modelId) {
      storedModel = await this.getModel(modelId);
      if (storedModel) {
        modelName = modelName || storedModel.name;
        baseUrl = baseUrl || storedModel.baseUrl;
        provider = provider || storedModel.provider;
        adapter = adapter || storedModel.adapter;
        if (!resolvedApiKey) {
          resolvedApiKey = await resolveAndDecryptApiKey(storedModel.ApiKey);
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
      adapter,
      // Native adapters need a Model-shaped object to run via getCompletionAdapter.
      model: storedModel ?? undefined,
    });
  }

  /**
   * Single-turn chat completion for the OpenAI-compatible `/v1/chat/completions`
   * endpoint (`model-<identifier>` requests). One request → one provider call →
   * one OpenAI-shaped response.
   *
   * Explicitly NOT included (this is the flow layer's job, see ModelHandler):
   * MCP tool execution loop, tool-approval gates, conversation persistence,
   * event-bus emission, debugger.
   *
   * Identifier resolution: FLUJO enforces uniqueness on displayName only; the
   * technical `name` may legitimately repeat across configured models. So the
   * identifier is matched case-insensitively against displayName FIRST, and
   * only when no display name matches, against the technical name. Zero
   * matches → 404, more than one → 400 (ambiguous) rather than guessing.
   *
   * SECURITY: the decrypted API key stays inside this method (passed to the
   * backend completion adapter only). It is never logged and never appears in
   * any returned error message. Provider errors are reduced to sanitized
   * message/type/code/param fields.
   */
  async generateChatCompletion(params: {
    /** The identifier with the `model-` prefix already stripped. */
    modelIdentifier: string;
    messages: OpenAI.ChatCompletionMessageParam[];
    temperature?: number;
    /** Client-supplied tool definitions — passed through per standard OpenAI semantics. */
    tools?: OpenAI.ChatCompletionTool[];
  }): Promise<DirectCompletionResult> {
    const { modelIdentifier, messages, tools } = params;
    log.debug('generateChatCompletion: Entering method', {
      modelIdentifier,
      messageCount: messages?.length || 0,
      hasTools: Boolean(tools && tools.length > 0),
    });

    try {
      // --- Resolve the identifier to a configured model (displayName first) ---
      const models = await this.loadModels();
      const needle = modelIdentifier.trim().toLowerCase();

      let candidates = models.filter(
        m => (m.displayName?.trim().toLowerCase() || '') === needle
      );
      if (candidates.length === 0) {
        candidates = models.filter(m => (m.name || '').trim().toLowerCase() === needle);
      }

      if (candidates.length === 0) {
        return {
          success: false,
          error: {
            message: `Model not found: model-${modelIdentifier}`,
            type: 'invalid_request_error',
            code: 'model_not_found',
            param: 'model',
          },
          statusCode: 404,
        };
      }
      if (candidates.length > 1) {
        return {
          success: false,
          error: {
            message:
              `The identifier "${modelIdentifier}" matches more than one configured model. ` +
              'Address the model by its unique display name instead.',
            type: 'invalid_request_error',
            code: 'model_ambiguous',
            param: 'model',
          },
          statusCode: 400,
        };
      }
      const model = candidates[0];

      // The Claude-subscription adapter self-orchestrates an agentic loop when
      // given tools, which diverges from standard OpenAI tool semantics (the
      // CLIENT is supposed to execute its own tools). Reject rather than
      // silently diverge.
      if (model.adapter === 'claude-cli' && tools && tools.length > 0) {
        return {
          success: false,
          error: {
            message: 'Tool definitions are not supported for this model via the direct completion endpoint.',
            type: 'invalid_request_error',
            code: 'tools_not_supported_for_this_model',
            param: 'tools',
          },
          statusCode: 400,
        };
      }

      // --- Resolve + decrypt the API key (never logged, never returned) ---
      const decryptedApiKey = await resolveAndDecryptApiKey(model.ApiKey);
      if (!decryptedApiKey) {
        return {
          success: false,
          error: {
            message: 'Failed to resolve the API key for this model.',
            type: 'api_error',
            code: 'api_key_error',
            param: null,
          },
          statusCode: 500,
        };
      }

      const temperature =
        typeof params.temperature === 'number'
          ? params.temperature
          : model.temperature
            ? parseFloat(model.temperature)
            : 0.0;

      // --- Single provider call through the completion-adapter seam ---
      const adapter = getCompletionAdapter(model);
      log.debug('generateChatCompletion: calling completion adapter', {
        adapter: model.adapter || 'openai',
        model: model.name,
        temperature,
      });

      const { completion } = await adapter.createCompletion({
        model,
        apiKey: decryptedApiKey,
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        temperature,
        // Only relevant for self-orchestrating adapters: keep it single-turn.
        maxTurns: 1,
      });

      // Some providers (e.g. OpenRouter) return HTTP 200 with an error object
      // in the body instead of throwing. Sanitize before echoing to the client.
      if (completion && typeof completion === 'object' && 'error' in completion && (completion as { error?: unknown }).error) {
        const body = (completion as { error?: unknown }).error as Record<string, unknown>;
        log.warn('generateChatCompletion: provider returned an in-band error object', {
          code: body?.code,
          type: body?.type,
        });
        return {
          success: false,
          error: ModelService.sanitizeProviderError(body),
          statusCode: 502,
        };
      }

      if (!completion?.choices?.[0]) {
        return {
          success: false,
          error: {
            message: 'Invalid response structure from provider: missing choices.',
            type: 'api_error',
            code: 'invalid_provider_response',
            param: null,
          },
          statusCode: 502,
        };
      }

      // Return the adapter's OpenAI-shaped completion unchanged, except the
      // public model id so clients see the identifier they addressed.
      return {
        success: true,
        completion: { ...completion, model: `model-${modelIdentifier}` },
      };
    } catch (error) {
      // Never include the key or the raw provider payload in what goes back out.
      log.error('generateChatCompletion: provider call failed', {
        modelIdentifier,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof OpenAI.APIError) {
        const body = (error as unknown as { error?: unknown }).error as Record<string, unknown> | undefined;
        const sanitized = ModelService.sanitizeProviderError(body, error.message);
        return {
          success: false,
          error: {
            message: sanitized.message,
            type: sanitized.type !== 'api_error' ? sanitized.type : (typeof error.type === 'string' ? error.type : 'api_error'),
            code: sanitized.code !== 'provider_error' ? sanitized.code : (typeof error.code === 'string' ? error.code : 'provider_error'),
            param: sanitized.param ?? (typeof error.param === 'string' ? error.param : null),
          },
          statusCode: typeof error.status === 'number' ? error.status : 500,
        };
      }

      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to generate completion',
          type: 'api_error',
          code: 'internal_error',
          param: null,
        },
        statusCode: 500,
      };
    }
  }

  /**
   * Reduce a provider error body to client-safe scalar fields. Mirrors the
   * message-extraction of ModelHandler.extractProviderErrorDetails (including
   * OpenRouter's nested `metadata.raw`) but deliberately DROPS the raw provider
   * payload — it can echo request internals and must not reach `/v1` clients.
   */
  private static sanitizeProviderError(
    body: Record<string, unknown> | undefined,
    baseMessage?: string
  ): { message: string; type: string; code: string; param?: string | null } {
    let message =
      baseMessage ||
      (typeof body?.message === 'string' ? (body.message as string) : '') ||
      'Provider returned an unspecified error.';

    if (
      baseMessage &&
      typeof body?.message === 'string' &&
      body.message &&
      body.message !== baseMessage
    ) {
      message = `${baseMessage} - ${body.message}`;
    }

    // OpenRouter nests the real upstream reason under metadata.raw.
    const meta = body?.metadata as Record<string, unknown> | undefined;
    if (meta) {
      let rawMsg: string | undefined;
      if (typeof meta.raw === 'string') {
        try {
          const parsed = JSON.parse(meta.raw);
          rawMsg = parsed?.error?.message || parsed?.message || meta.raw;
        } catch {
          rawMsg = meta.raw;
        }
      } else if (meta.raw && typeof meta.raw === 'object') {
        const rawObj = meta.raw as { error?: { message?: string }; message?: string };
        rawMsg = rawObj.error?.message || rawObj.message;
      }
      const upstreamParts: string[] = [];
      if (meta.provider_name) upstreamParts.push(String(meta.provider_name));
      if (rawMsg) upstreamParts.push(rawMsg);
      if (upstreamParts.length > 0) {
        message = `${message} (upstream: ${upstreamParts.join(': ')})`;
      }
    }

    return {
      message,
      type: typeof body?.type === 'string' ? (body.type as string) : 'api_error',
      code: typeof body?.code === 'string' ? (body.code as string) : 'provider_error',
      param: typeof body?.param === 'string' ? (body.param as string) : null,
    };
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
