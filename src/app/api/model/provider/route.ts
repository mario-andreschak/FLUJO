import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { fetchProviderModels } from '../backend-provider-adapter';

const log = createLogger('app/api/model/provider/route');

export async function POST(request: NextRequest) {
  try {
    const { baseUrl, modelId, searchTerm } = await request.json();

    if (!baseUrl) {
      return new Response(JSON.stringify({ error: 'Base URL is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!modelId) {
      return new Response(JSON.stringify({ error: 'Model ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    log.debug('Processing provider models request', {
      baseUrl,
      modelId,
      searchTerm: searchTerm ? `"${searchTerm}"` : 'none'
    });

    // Fetch available models from the provider using the adapter
    // The adapter will delegate to the backend service which handles API key resolution, decryption, caching, and filtering
    const models = await fetchProviderModels(baseUrl, modelId, searchTerm);

    log.debug('Provider models request completed', {
      baseUrl,
      modelCount: models.length,
      searchTerm: searchTerm ? `"${searchTerm}"` : 'none'
    });

    return new Response(JSON.stringify({ models }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('Error handling provider models request', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
