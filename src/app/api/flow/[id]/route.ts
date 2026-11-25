import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { Flow } from '@/shared/types/flow';
import { flowService } from '@/backend/services/flow';
import {
  deleteFlowAndMoveUses,
  findFlowUsage,
  flowDeleteTouchesPersonas,
  flowInUseBody,
} from '@/backend/services/flow/flowDeletion';
import { checkBaseRevision, currentSharedEditor, recordChange } from '@/backend/services/sharedItems/guard';
import { parseFlowDeletePlan } from '@/shared/types/flow/flowUsage';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { json } from '../_helpers';

const log = createLogger('app/api/flow/[id]/route');

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/flow/{id}
 * Get a single flow by ID.
 */
async function GET_handler(_request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;

    const flow = await flowService.getFlow(id);
    if (!flow) {
      return json({ error: `Flow "${id}" not found` }, 404);
    }

    return json(flow, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * PUT /api/flow/{id}
 * Update an existing flow. The path ID is authoritative and overrides any ID in the
 * body. Returns 404 when the flow does not exist (use POST /api/flow to create).
 */
async function PUT_handler(request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    const body = (await request.json()) as Flow;

    if (!body || typeof body !== 'object') {
      return json({ error: 'A flow is required' }, 400);
    }

    const existing = await flowService.getFlow(id);
    if (!existing) {
      return json({ error: `Flow "${id}" not found` }, 404);
    }

    // Multi-user mode (#575): refuse to silently replace a newer save by
    // someone else. `editor` is null while the mode is off.
    const editor = await currentSharedEditor();
    const conflict = await checkBaseRevision(request, editor, 'flow', id, existing);
    if (conflict) return conflict;

    // The path segment is the source of truth for which flow is being updated.
    const flow: Flow = {
      ...body,
      id,
      // Ownership is server-authored and cannot be forged or removed by Builder saves.
      ...(existing.personaOwnership
        ? { personaOwnership: existing.personaOwnership }
        : { personaOwnership: undefined }),
    };

    // With an editor the save also checks, under the flow lock, that nobody
    // saved between the check above and this write.
    const result = await flowService.saveFlow(flow, editor && typeof existing.updatedAt === 'number'
      ? { expectedUpdatedAt: existing.updatedAt } : {});
    if (!result.success) {
      if (editor && result.error === 'Flow changed since inspection.') {
        const newer = await flowService.getFlow(id);
        const raced = newer && await checkBaseRevision(request, editor, 'flow', id, newer);
        if (raced) return raced;
      }
      return json({ error: result.error || 'Failed to update flow' }, 400);
    }
    await recordChange(editor, { kind: 'flow', itemId: id, action: 'saved', before: existing, after: flow });

    return json(flow, 200);
  } catch (error) {
    log.error('Error handling PUT request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/flow/{id}
 * Delete a flow by ID (204). When Personas, automations or other flows still
 * use it, the answer is 409 `FLOW_IN_USE` with every place. Send the person's
 * choices as `{ plan: { choices: { [place key]: { replaceWith } | { remove: true } } } }`
 * to switch or release each place first; the flow is deleted last (200).
 */
async function DELETE_handler(request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    const plan = parseFlowDeletePlan(await request.json().catch(() => null));
    if (plan === 'invalid') {
      return json({ error: 'The choices for deleting this flow could not be read.' }, 400);
    }

    const usage = await findFlowUsage(id);
    if (!usage) {
      return json({ error: `Flow "${id}" not found` }, 404);
    }

    // Changing a Persona needs the same access as the Persona pages.
    const changesPlaces = plan !== null || (usage.uses.length === 0 && usage.copySources.length > 0);
    const touches = flowDeleteTouchesPersonas(usage);
    if (changesPlaces && touches.personas) {
      const notLocal = assertLocalRequest(request);
      if (notLocal) return notLocal;
    }
    if (changesPlaces && touches.personaAutomations) {
      const notLocal = assertLocalRequest(request, { strictLoopback: true });
      if (notLocal) return notLocal;
    }

    const outcome = await deleteFlowAndMoveUses(id, plan, await currentSharedEditor());
    switch (outcome.status) {
      case 'not-found':
        return json({ error: `Flow "${id}" not found` }, 404);
      case 'in-use':
        return json(flowInUseBody(outcome.usage, outcome.changed), 409);
      case 'refused':
        return json({ error: outcome.error, code: outcome.busy ? 'PERSONA_BUSY' : 'FLOW_DELETE_REFUSED' }, 409);
      case 'deleted':
        return plan ? json({ deleted: true, summary: outcome.summary }, 200) : new Response(null, { status: 204 });
    }
  } catch (error) {
    log.error('Error handling DELETE request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const PUT = withWorkspaceRoute(PUT_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
