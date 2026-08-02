import { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import type { Flow } from '@/shared/types/flow';
import type { StepToolSuggestion } from '@/shared/types/flow/assistance';
import {
  applyToolsToFlowStep,
  checkFlowPlausibility,
  generateFlowName,
  suggestToolsForFlowStep,
} from '@/backend/services/flow/assistedAuthoring';
import { json } from '../_helpers';

function isFlow(value: unknown): value is Flow {
  return !!value && typeof value === 'object'
    && Array.isArray((value as Flow).nodes)
    && Array.isArray((value as Flow).edges);
}

export async function POST(request: NextRequest) {
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !isFlow(body.flow)) return json({ error: 'A valid flow is required.' }, 400);
  const action = typeof body.action === 'string' ? body.action : '';
  try {
    if (action === 'generate-name') {
      if (typeof body.modelId !== 'string') {
        return json({ error: 'modelId is required.' }, 400);
      }
      return json(await generateFlowName({
        flow: body.flow,
        modelId: body.modelId,
        existingNames: Array.isArray(body.existingNames)
          ? body.existingNames.filter((name): name is string => typeof name === 'string')
          : undefined,
      }));
    }
    if (action === 'suggest-tools') {
      if (typeof body.nodeId !== 'string' || typeof body.modelId !== 'string') {
        return json({ error: 'nodeId and modelId are required.' }, 400);
      }
      return json(await suggestToolsForFlowStep({
        flow: body.flow,
        nodeId: body.nodeId,
        modelId: body.modelId,
        goal: typeof body.goal === 'string' ? body.goal : undefined,
      }));
    }
    if (action === 'apply-tools') {
      if (typeof body.nodeId !== 'string' || !Array.isArray(body.selections)) {
        return json({ error: 'nodeId and selections are required.' }, 400);
      }
      const selections = body.selections.filter((selection): selection is StepToolSuggestion =>
        !!selection && typeof selection === 'object'
        && typeof (selection as StepToolSuggestion).server === 'string'
        && typeof (selection as StepToolSuggestion).tool === 'string'
        && typeof (selection as StepToolSuggestion).reason === 'string',
      );
      return json({ flow: await applyToolsToFlowStep({
        flow: body.flow,
        nodeId: body.nodeId,
        selections,
        proposedPrompt: typeof body.proposedPrompt === 'string' ? body.proposedPrompt : undefined,
      }) });
    }
    if (action === 'check-plausibility') {
      const relatedFlows = Array.isArray(body.relatedFlows) ? body.relatedFlows.filter(isFlow) : undefined;
      return json(await checkFlowPlausibility({
        flow: body.flow,
        relatedFlows,
        modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
        intendedContext: body.intendedContext === 'headless' ? 'headless' : 'chat',
      }));
    }
    return json({ error: 'Unknown assistance action.' }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 422);
  }
}
