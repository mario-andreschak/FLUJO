import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { improveFlow } from '@/backend/services/flow/generateFlow';
import { Flow } from '@/shared/types/flow';
import { json } from '../_helpers';

const log = createLogger('app/api/flow/improve/route');

/**
 * POST /api/flow/improve
 * Revise an EXISTING flow from a natural-language change request (issue #99).
 *
 * Body: { flow: Flow, description: string, modelId: string, maxRepairs?: number,
 *         allowInstall?: boolean }
 * Response: { flow, validation, flows, rootFlowId, attempts, installedServers } —
 * `flow` is the UNSAVED revised draft (same id as the flow that was sent, so the builder
 * applies it in place for review). `flows` is a single-entry bundle for shape-parity with
 * /api/flow/generate. Nothing is persisted here, and nothing key-shaped is ever returned
 * (the model call runs entirely backend-side).
 *
 * `allowInstall` lets the improver INSTALL MCP servers from the public registry (download +
 * run third-party packages) when the requested change needs a missing capability — strictly
 * opt-in per request; installs are listed in `installedServers`.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = (await request.json().catch(() => null)) as {
      flow?: Flow;
      description?: string;
      modelId?: string;
      maxRepairs?: number;
      allowInstall?: boolean;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ error: 'Request body must be a JSON object' }, 400);
    }
    const flow = body.flow;
    if (
      !flow ||
      typeof flow !== 'object' ||
      !Array.isArray((flow as Flow).nodes) ||
      !Array.isArray((flow as Flow).edges)
    ) {
      return json({ error: 'A valid flow to improve is required' }, 400);
    }
    if (typeof body.description !== 'string' || !body.description.trim()) {
      return json({ error: 'A change description is required' }, 400);
    }
    if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
      return json({ error: 'A generator model id is required' }, 400);
    }

    const result = await improveFlow({
      flow: flow as Flow,
      description: body.description,
      modelId: body.modelId,
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
