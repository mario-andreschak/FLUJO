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
 *         allowInstall?: boolean, allowSubflows?: boolean, maxDepth?: number }
 * Response: { flow, validation, flows, rootFlowId, attempts, installedServers } —
 * `flow` is the UNSAVED root draft, `flows` the whole bundle (root + auto-generated
 * subflow descendants, dependency order) each with its own validation. The caller
 * opens the root in the FlowBuilder for review and persists the bundle via the normal
 * save path (descendants first). Nothing is stored here, and nothing key-shaped is
 * ever returned (the model call runs entirely backend-side).
 *
 * allowInstall lets the generator INSTALL MCP servers from the public registry
 * (download + run third-party packages) when the flow needs missing
 * capabilities — strictly opt-in per request; installs are listed in
 * `installedServers`.
 *
 * allowSubflows lets the generator author MULTI-LEVEL flows (issue #94): subflow nodes
 * that are themselves auto-generated, up to `maxDepth` levels deep.
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
      allowSubflows?: boolean;
      maxDepth?: number;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ error: 'Request body must be a JSON object' }, 400);
    }

    const result = await generateFlow({
      description: body.description ?? '',
      modelId: body.modelId ?? '',
      maxRepairs: body.maxRepairs,
      allowInstall: body.allowInstall === true,
      allowSubflows: body.allowSubflows === true,
      maxDepth: body.maxDepth,
    });

    if (!result.success) {
      return json({ error: result.error }, result.statusCode);
    }
    return json(
      {
        flow: result.flow,
        validation: result.validation,
        flows: result.flows,
        rootFlowId: result.rootFlowId,
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
