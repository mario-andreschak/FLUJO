import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { repairFlowWithAI } from '@/backend/services/flow/generateFlow';
import { autoRepairFlow } from '@/utils/shared/flowAutoRepair';
import { Flow } from '@/shared/types/flow';
import { json } from '../_helpers';

const log = createLogger('app/api/flow/repair/route');

/**
 * POST /api/flow/repair
 * Auto-repair a flow's wiring: add a missing Start/Finish and connect disconnected nodes.
 *
 * Body: { flow: Flow, mode?: 'static' | 'ai', modelId?: string, maxRepairs?: number,
 *         allowInstall?: boolean }
 *
 * - mode 'static' (default): DETERMINISTIC, offline. Runs the pure position-aware planner
 *   (autoRepairFlow) — no model, no key access, works while locked. Response: { flow, changes }.
 * - mode 'ai': reuses the improveFlow seam via repairFlowWithAI (needs a model + unlock).
 *   Response mirrors /api/flow/improve: { flow, validation, flows, rootFlowId, attempts,
 *   installedServers }.
 *
 * Both return an UNSAVED draft — the builder applies it to the canvas for review; nothing is
 * persisted here and nothing key-shaped is ever returned.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      flow?: Flow;
      mode?: 'static' | 'ai';
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
      return json({ error: 'A valid flow to repair is required' }, 400);
    }

    const mode = body.mode === 'ai' ? 'ai' : 'static';

    if (mode === 'ai') {
      const _lock = await assertUnlocked();
      if (_lock) return _lock;
      if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
        return json({ error: 'A repair model id is required for AI-supported repair' }, 400);
      }
      const result = await repairFlowWithAI({
        flow: flow as Flow,
        modelId: body.modelId,
        maxRepairs: body.maxRepairs,
        allowInstall: body.allowInstall === true,
      });
      if (!result.success) {
        return json({ error: result.error }, result.statusCode);
      }
      return json(
        {
          mode,
          flow: result.flow,
          validation: result.validation,
          flows: result.flows,
          rootFlowId: result.rootFlowId,
          attempts: result.attempts,
          installedServers: result.installedServers,
        },
        200
      );
    }

    // Static: pure + offline.
    const { flow: repaired, changes } = autoRepairFlow(flow as Flow);
    return json({ mode, flow: repaired, changes }, 200);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
