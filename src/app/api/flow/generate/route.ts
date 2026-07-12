import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { generateFlow } from '@/backend/services/flow/generateFlow';
import { json } from '../_helpers';

const log = createLogger('app/api/flow/generate/route');

/**
 * POST /api/flow/generate
 * Generate a draft flow from a natural-language description (issue #14).
 *
 * Body: { description: string, modelId: string, maxRepairs?: number,
 *         allowInstall?: boolean }
 * Response: { flow, validation, attempts, installedServers } — the flow is an
 * UNSAVED draft; the caller opens it in the FlowBuilder for review and persists
 * it via the normal POST /api/flow save path. Nothing is stored here, and
 * nothing key-shaped is ever returned (the model call runs entirely
 * backend-side).
 *
 * allowInstall lets the generator INSTALL MCP servers from the public registry
 * (download + run third-party packages) when the flow needs missing
 * capabilities — strictly opt-in per request; installs are listed in
 * `installedServers`.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = (await request.json().catch(() => null)) as {
      description?: string;
      modelId?: string;
      maxRepairs?: number;
      allowInstall?: boolean;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ error: 'Request body must be a JSON object' }, 400);
    }

    const result = await generateFlow({
      description: body.description ?? '',
      modelId: body.modelId ?? '',
      maxRepairs: body.maxRepairs,
      allowInstall: body.allowInstall === true,
    });

    if (!result.success) {
      return json({ error: result.error }, result.statusCode);
    }
    return json(
      {
        flow: result.flow,
        validation: result.validation,
        attempts: result.attempts,
        installedServers: result.installedServers,
      },
      200
    );
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
