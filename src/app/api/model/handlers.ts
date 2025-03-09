import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import * as modelAdapter from './model-adapter';
import * as providerAdapter from './provider-adapter';
import { ProcessNodeUtility } from '@/backend/execution/flow/nodes/util/ProcessNodeUtility';

// Create a logger instance for this file
const log = createLogger('app/api/model/handlers');

/**
 * Handle GET requests
 */
export async function GET(req: NextRequest) {
  log.debug('GET: Entering method');
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    if (!action) {
      return NextResponse.json({ error: 'Action is required' }, { status: 400 });
    }

    // Handle different actions
    if (action === 'fetchModels') {
      const baseUrl = searchParams.get('baseUrl');
      const modelId = searchParams.get('modelId');
      
      if (!baseUrl) {
        return NextResponse.json({ error: 'Base URL is required' }, { status: 400 });
      }
      
      log.debug(`GET: Fetching models for baseUrl: ${baseUrl}`);
      
      try {
        // Fetch models based on provider
        const models = await providerAdapter.fetchProviderModels(baseUrl, modelId || undefined);
        
        // Return normalized response
        return NextResponse.json({
          data: models
        });
      } catch (error) {
        log.error(`GET: Error fetching models for ${baseUrl}:`, error);
        return NextResponse.json({ 
          error: `Error fetching models: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    } 
    // Keep backward compatibility with fetchOpenRouterModels
    else if (action === 'fetchOpenRouterModels') {
      log.debug('GET: Fetching OpenRouter models (legacy endpoint)');
      
      try {
        const models = await providerAdapter.fetchProviderModels('https://openrouter.ai/api/v1');
        return NextResponse.json({
          data: models
        });
      } catch (error) {
        log.error('GET: Error fetching OpenRouter models:', error);
        return NextResponse.json({ 
          error: `Error fetching OpenRouter models: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // New endpoint to list all models
    else if (action === 'listModels') {
      log.debug('GET: Listing all models');
      
      try {
        const result = await modelAdapter.loadModels();
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 500 });
        }
        
        return NextResponse.json({
          success: true,
          models: result.models
        });
      } catch (error) {
        log.error('GET: Error listing models:', error);
        return NextResponse.json({ 
          error: `Error listing models: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Get a specific model
    else if (action === 'getModel') {
      const modelId = searchParams.get('id');
      
      if (!modelId) {
        return NextResponse.json({ error: 'Model ID is required' }, { status: 400 });
      }
      
      log.debug(`GET: Getting model with ID: ${modelId}`);
      
      try {
        const result = await modelAdapter.getModel(modelId);
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 404 });
        }
        
        return NextResponse.json({
          success: true,
          model: result.model
        });
      } catch (error) {
        log.error(`GET: Error getting model ${modelId}:`, error);
        return NextResponse.json({ 
          error: `Error getting model: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Check encryption status
    else if (action === 'checkEncryption') {
      log.debug('GET: Checking encryption status');
      
      try {
        const isConfigured = await modelAdapter.isEncryptionConfigured();
        const isUserEnabled = await modelAdapter.isUserEncryptionEnabled();
        
        return NextResponse.json({
          success: true,
          initialized: isConfigured,
          userEncryption: isUserEnabled
        });
      } catch (error) {
        log.error('GET: Error checking encryption status:', error);
        return NextResponse.json({ 
          error: `Error checking encryption status: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    log.error('GET: Model API error:', error);
    return NextResponse.json({ 
      error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}

/**
 * Handle POST requests
 */
export async function POST(req: NextRequest) {
  log.debug('POST: Entering method');
  try {
    const body = await req.json();
    const { action } = body;

    if (!action) {
      return NextResponse.json({ error: 'Action is required' }, { status: 400 });
    }

    // Handle different actions
    if (action === 'generateCompletion') {
      const { modelId, prompt, messages = [] } = body;
      
      if (!modelId || !prompt) {
        return NextResponse.json({ error: 'Model ID and prompt are required' }, { status: 400 });
      }

      log.debug(`POST: Generating completion with model: ${modelId}`);
      
      try {
        const result = await ProcessNodeUtility.generateCompletion(modelId, prompt, messages);
        log.debug(`POST: ProcessNodeUtility.generateCompletion Response: ${result}`);
        
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 500 });
        }
        return NextResponse.json({ 
          content: result.content,
          fullResponse: result.fullResponse
        });
      } catch (error) {
        log.error('POST: Error generating completion:', error);
        return NextResponse.json({ 
          error: `Error generating completion: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Add a new model
    else if (action === 'addModel') {
      const { model } = body;
      
      if (!model) {
        return NextResponse.json({ error: 'Model data is required' }, { status: 400 });
      }
      
      log.debug('POST: Adding new model');
      
      try {
        const result = await modelAdapter.addModel(model);
        
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        
        return NextResponse.json({
          success: true,
          model: result.model
        });
      } catch (error) {
        log.error('POST: Error adding model:', error);
        return NextResponse.json({ 
          error: `Error adding model: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Update an existing model
    else if (action === 'updateModel') {
      const { model } = body;
      
      if (!model) {
        return NextResponse.json({ error: 'Model data is required' }, { status: 400 });
      }
      
      log.debug(`POST: Updating model with ID: ${model.id}`);
      
      try {
        const result = await modelAdapter.updateModel(model);
        
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        
        return NextResponse.json({
          success: true,
          model: result.model
        });
      } catch (error) {
        log.error('POST: Error updating model:', error);
        return NextResponse.json({ 
          error: `Error updating model: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Delete a model
    else if (action === 'deleteModel') {
      const { id } = body;
      
      if (!id) {
        return NextResponse.json({ error: 'Model ID is required' }, { status: 400 });
      }
      
      log.debug(`POST: Deleting model with ID: ${id}`);
      
      try {
        const result = await modelAdapter.deleteModel(id);
        
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        
        return NextResponse.json({
          success: true
        });
      } catch (error) {
        log.error('POST: Error deleting model:', error);
        return NextResponse.json({ 
          error: `Error deleting model: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Set encryption key
    else if (action === 'setEncryptionKey') {
      const { key } = body;
      
      if (!key) {
        return NextResponse.json({ error: 'Encryption key is required' }, { status: 400 });
      }
      
      log.debug('POST: Setting encryption key');
      
      try {
        const result = await modelAdapter.setEncryptionKey(key);
        
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 500 });
        }
        
        return NextResponse.json({
          success: true
        });
      } catch (error) {
        log.error('POST: Error setting encryption key:', error);
        return NextResponse.json({ 
          error: `Error setting encryption key: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    }
    // Encrypt API key
    else if (action === 'encryptApiKey') {
      const { apiKey } = body;
      
      if (!apiKey) {
        return NextResponse.json({ error: 'API key is required' }, { status: 400 });
      }
      
      log.debug('POST: Encrypting API key');
      
      try {
        const encryptedKey = await modelAdapter.encryptApiKey(apiKey);
        
        if (!encryptedKey) {
          return NextResponse.json({ error: 'Failed to encrypt API key' }, { status: 500 });
        }
        
        return NextResponse.json({
          success: true,
          result: encryptedKey
        });
      } catch (error) {
        log.error('POST: Error encrypting API key:', error);
        return NextResponse.json({ 
          error: `Error encrypting API key: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, { status: 500 });
      }
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    log.error('POST: Model API error:', error);
    return NextResponse.json({ 
      error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}
