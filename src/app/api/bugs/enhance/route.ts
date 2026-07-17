import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { enhanceBugReport } from '@/backend/services/bugReport/enhance';

const log = createLogger('app/api/bugs/enhance/route');

/** Build a JSON Response with the given status code. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/bugs/enhance
 * Polish/classify a draft bug report with a user-selected model (issue #127).
 *
 * Body: { modelId: string, title: string, description: string, context?: SafeBugContext }
 * Response: EnhanceResult ({ title, body, labels[], severity?, enhanced }).
 *
 * Gated behind the encryption unlock. The AI call runs entirely backend-side (keys never
 * leave the server) and fails soft — on model error the original text is returned with
 * `enhanced: false`, never a 500 for the model itself.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = (await request.json().catch(() => null)) as {
      modelId?: string;
      title?: string;
      description?: string;
      context?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return json({ error: 'Request body must be a JSON object' }, 400);
    }

    const result = await enhanceBugReport({
      modelId: body.modelId ?? '',
      title: body.title ?? '',
      description: body.description ?? '',
      context: body.context,
    });

    if (!result.success) {
      return json({ error: result.error }, result.statusCode);
    }
    return json(result.result, result.statusCode);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
