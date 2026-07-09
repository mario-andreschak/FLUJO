import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { modelService } from '@/backend/services/model';

const log = createLogger('app/api/model/test/route');

/**
 * POST /api/model/test
 * Run a direct (no flow engine) connectivity test for a model.
 *
 * Body accepts either an existing model `modelId`, or the fields of an unsaved
 * draft (`name`, `baseUrl`, `apiKey`, `provider`). The API key is resolved and
 * used entirely on the backend; only the verbose, secret-free result is
 * returned to the caller.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { modelId, name, baseUrl, apiKey, provider } = await request.json();

    if (!modelId && !name) {
      return new Response(
        JSON.stringify({ error: 'A modelId or model name is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    log.info('Processing model test request', { modelId, name, baseUrl, hasApiKey: Boolean(apiKey) });

    const result = await modelService.testModel({ modelId, name, baseUrl, apiKey, provider });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('Error handling model test request', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
