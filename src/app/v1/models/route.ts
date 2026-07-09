import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextResponse } from 'next/server';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { Flow } from '@/frontend/types/flow/flow';
import { modelService } from '@/backend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/models/route');

export async function GET() {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  try {
    log.info('Fetching flows and models for models endpoint');

    // Load all flows directly from storage
    const flows = await loadItem<Flow[]>(StorageKey.FLOWS, []);
    log.debug('Flows loaded successfully', { count: flows.length });

    // Transform flows into the required format
    const flowEntries = flows.map(flow => ({
      id: `flow-${flow.name}`,
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
    try {
      const models = await modelService.loadModels();
      const seen = new Set<string>();
      for (const m of models) {
        const identifier = (m.displayName?.trim() || m.name || '').trim();
        if (!identifier) continue;
        const id = `model-${identifier}`;
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
    }

    // Return the models in the OpenAI format
    log.info('Returning models in OpenAI format', {
      flowCount: flowEntries.length,
      modelCount: modelEntries.length
    });
    return NextResponse.json({
      object: 'list',
      data: [...flowEntries, ...modelEntries]
    });
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
