import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { getProviderProfileById } from '@/shared/types/model/provider';
import { fetchProviderModels } from '../backend-provider-adapter';

const log = createLogger('app/api/model/provider/route');

async function POST_handler(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const rawBody: unknown = await request.json();
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = rawBody as Record<string, unknown>;
    const stringFields: Array<[string, number]> = [
      ['baseUrl', 4096],
      ['modelId', 256],
      ['searchTerm', 200],
      ['apiKey', 32768],
      ['profileId', 64],
    ];
    for (const [field, maxLength] of stringFields) {
      const value = body[field];
      if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) {
        return new Response(JSON.stringify({ error: `Invalid ${field}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const baseUrl = (body.baseUrl as string | undefined)?.trim() ?? '';
    const modelId = body.modelId as string | undefined;
    const searchTerm = body.searchTerm as string | undefined;
    const apiKey = body.apiKey as string | undefined;
    const profileId = body.profileId as string | undefined;
    const profile = profileId ? getProviderProfileById(profileId) : undefined;

    if (profileId && !profile) {
      return new Response(JSON.stringify({ error: 'Unsupported provider discovery profile' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const usesNativeGemini = profile?.id === 'gemini-native';
    if (!baseUrl && !usesNativeGemini) {
      return new Response(JSON.stringify({ error: 'Base URL is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // A direct key supports unsaved models; modelId lets the backend resolve a
    // stored encrypted key. An unauthenticated request remains valid for public
    // OpenAI-compatible catalogues.
    log.debug('Processing provider models request', {
      baseUrl,
      modelId,
      profileId,
      hasApiKey: Boolean(apiKey),
      searchTerm: searchTerm ? `"${searchTerm}"` : 'none',
    });

    const models = await fetchProviderModels(
      baseUrl,
      modelId,
      searchTerm,
      apiKey,
      profileId,
    );

    log.debug('Provider models request completed', {
      baseUrl,
      profileId,
      modelCount: models.length,
      searchTerm: searchTerm ? `"${searchTerm}"` : 'none',
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

export const POST = withWorkspaceRoute(POST_handler);
