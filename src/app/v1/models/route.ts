import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextResponse } from 'next/server';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { isTeamModel } from '@/shared/types/model/team';
import { isTeamFlow } from '@/shared/types/flow/team';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/models/route');

async function GET_handler(_request: Request) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  try {
    log.info('Fetching flows and models for models endpoint');

    // Use the same collection/migration path as saved agents and execution.
    const flowCatalogue = await flowService.listFlows({ includeShared: true });
    if (!flowCatalogue.success) throw new Error(flowCatalogue.error);
    const flows = flowCatalogue.flows ?? [];
    log.debug('Flows loaded successfully', { count: flows.length });

    // Transform flows into the required format
    const flowEntries = flows.map(flow => ({
      id: `flow-${isTeamFlow(flow) ? flow.id : flow.name}`,
      object: 'model'
    }));
    log.debug('Transformed flows into models', { modelCount: flowEntries.length });

    // Also expose configured FLUJO models as `model-<displayName || name>`.
    //
    // SECURITY: strict whitelist projection — only `id` and `object` are ever
    // serialized. Never spread the Model record here: it carries `ApiKey`,
    // `baseUrl`, `promptTemplate` and other provider/adapter internals that
    // must never leave the backend.
    //
    // The display name is the identifier of choice because FLUJO enforces
    // uniqueness on displayName only; the technical `name` (the provider's
    // model id, e.g. "openrouter/auto") may legitimately repeat across
    // configured models. See ModelService.generateChatCompletion for the
    // matching resolution logic on /v1/chat/completions.
    let modelEntries: { id: string; object: string }[] = [];
    let sharedModelsUnavailable = false;
    try {
      const catalogue = await modelService.listModels();
      if (!catalogue.success || !catalogue.models) throw new Error('Model catalogue unavailable.');
      const models = catalogue.models;
      sharedModelsUnavailable = Boolean(catalogue.sharedModelsUnavailable);
      const seen = new Set<string>();
      for (const m of models) {
        const identifier = (isTeamModel(m) ? m.id : m.fallbackPolicy ? m.name : m.displayName?.trim() || m.name || '').trim();
        if (!identifier) continue;
        const id = m.fallbackPolicy ? identifier : `model-${identifier}`;
        // Dedupe (possible when displayName-less models share a technical name).
        if (seen.has(id)) continue;
        seen.add(id);
        modelEntries.push({ id, object: 'model' });
      }
      log.debug('Transformed configured models into model entries', { modelCount: modelEntries.length });
    } catch (modelError) {
      // Model storage failure must not break flow listing — degrade gracefully.
      log.error('Failed to load configured models for models endpoint; returning flows only', modelError);
      modelEntries = [];
      sharedModelsUnavailable = true;
    }

    // Return the models in the OpenAI format
    log.info('Returning models in OpenAI format', {
      flowCount: flowEntries.length,
      modelCount: modelEntries.length
    });
    return NextResponse.json({
      object: 'list',
      data: [...flowEntries, ...modelEntries]
    }, { headers: { 'Cache-Control': 'no-store', 'X-Flujo-Shared-Models': sharedModelsUnavailable ? 'unavailable' : 'available',
      'X-Flujo-Shared-Flows': flowCatalogue.sharedFlowsUnavailable ? 'unavailable' : 'available' } });
  } catch (error) {
    log.error('Error fetching models', error);
    return NextResponse.json(
      { 
        error: {
          message: 'Failed to fetch models',
          type: 'internal_error',
          code: 'internal_error'
        }
      },
      { status: 500 }
    );
  }
}

const GET_workspaceRoute = withWorkspaceRoute(GET_handler);
export function GET(): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request = new Request('http://localhost/')) {
  return GET_workspaceRoute(request);
}
