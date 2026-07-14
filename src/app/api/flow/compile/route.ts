import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { compileSpec } from '@/backend/services/flow/compileFlow';
import { json } from '../_helpers';

const log = createLogger('app/api/flow/compile/route');

/**
 * POST /api/flow/compile
 * Deterministically compile a FlowSpec (the semantic authoring format — see the
 * in-app docs) into a Flow, validate it, and optionally save it. No LLM involved:
 * this is the programmatic authoring surface for external agents, so they never
 * have to write raw ReactFlow JSON.
 *
 * Body: { spec: FlowSpec, save?: boolean }
 * Response: { flow, flows, validation, saved } — 201 when saved, 200 otherwise.
 * `flow` is the root; `flows` is the whole bundle when the spec nests inline child
 * flows via `subflowSpec` (#94). `save` only persists when validation finds ZERO
 * errors across the whole bundle; iterate on the returned issues until clean.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = (await request.json().catch(() => null)) as {
      spec?: unknown;
      save?: boolean;
    } | null;
    if (!body || typeof body !== 'object') {
      return json({ error: 'Request body must be a JSON object with a "spec" field' }, 400);
    }

    const result = await compileSpec(body.spec, { save: body.save === true });

    if (!result.success) {
      return json({ error: result.error, ...(result.issues ? { issues: result.issues } : {}) }, result.statusCode);
    }
    return json(
      { flow: result.flow, flows: result.flows, validation: result.validation, saved: result.saved },
      result.saved ? 201 : 200
    );
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
