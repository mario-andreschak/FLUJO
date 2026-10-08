import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import type { Flow } from '@/shared/types/flow';
import type {
  StepAgentSuggestion,
  StepToolSuggestion,
  StepToolSuggestionResult,
} from '@/shared/types/flow/assistance';
import {
  applyAgentsToFlowStep,
  applyToolsToFlowStep,
  checkFlowPlausibility,
  generateFlowName,
  improvePromptForFlowStep,
  suggestAgentsForFlowStep,
  suggestToolsForFlowStep,
} from '@/backend/services/flow/assistedAuthoring';
import { json } from '../_helpers';

function isFlow(value: unknown): value is Flow {
  return !!value && typeof value === 'object'
    && Array.isArray((value as Flow).nodes)
    && Array.isArray((value as Flow).edges);
}

function isStepToolSuggestion(value: unknown): value is StepToolSuggestion {
  return !!value && typeof value === 'object'
    && typeof (value as StepToolSuggestion).server === 'string'
    && typeof (value as StepToolSuggestion).tool === 'string'
    && typeof (value as StepToolSuggestion).reason === 'string';
}

function isStepToolSuggestionResult(value: unknown): value is StepToolSuggestionResult {
  return !!value && typeof value === 'object'
    && typeof (value as StepToolSuggestionResult).nodeId === 'string'
    && Array.isArray((value as StepToolSuggestionResult).suggestions)
    && (value as StepToolSuggestionResult).suggestions.every(isStepToolSuggestion)
    && typeof (value as StepToolSuggestionResult).proposedPrompt === 'string';
}

function isStepAgentSuggestion(value: unknown): value is StepAgentSuggestion {
  return !!value && typeof value === 'object'
    && typeof (value as StepAgentSuggestion).flowId === 'string'
    && typeof (value as StepAgentSuggestion).flowName === 'string'
    && typeof (value as StepAgentSuggestion).reason === 'string';
}

async function POST_handler(request: NextRequest) {
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
        relatedFlows: Array.isArray(body.relatedFlows) ? body.relatedFlows.filter(isFlow) : undefined,
        nodeId: body.nodeId,
        modelId: body.modelId,
        goal: typeof body.goal === 'string' ? body.goal : undefined,
        feedback: Array.isArray(body.feedback)
          ? body.feedback.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        previousSuggestion: isStepToolSuggestionResult(body.previousSuggestion)
          ? body.previousSuggestion
          : undefined,
      }));
    }
    if (action === 'apply-tools') {
      if (typeof body.nodeId !== 'string' || !Array.isArray(body.selections)) {
        return json({ error: 'nodeId and selections are required.' }, 400);
      }
      const selections = body.selections.filter(isStepToolSuggestion);
      return json({ flow: await applyToolsToFlowStep({
        flow: body.flow,
        nodeId: body.nodeId,
        selections,
        proposedPrompt: typeof body.proposedPrompt === 'string' ? body.proposedPrompt : undefined,
      }) });
    }
    if (action === 'suggest-agents') {
      if (typeof body.nodeId !== 'string' || typeof body.modelId !== 'string') {
        return json({ error: 'nodeId and modelId are required.' }, 400);
      }
      return json(await suggestAgentsForFlowStep({
        flow: body.flow,
        nodeId: body.nodeId,
        modelId: body.modelId,
        goal: typeof body.goal === 'string' ? body.goal : undefined,
      }));
    }
    if (action === 'apply-agents') {
      if (typeof body.nodeId !== 'string' || !Array.isArray(body.selections)) {
        return json({ error: 'nodeId and selections are required.' }, 400);
      }
      return json({ flow: await applyAgentsToFlowStep({
        flow: body.flow,
        nodeId: body.nodeId,
        selections: body.selections.filter(isStepAgentSuggestion),
      }) });
    }
    if (action === 'improve-prompt') {
      if (typeof body.nodeId !== 'string' || typeof body.modelId !== 'string') {
        return json({ error: 'nodeId and modelId are required.' }, 400);
      }
      return json(await improvePromptForFlowStep({
        flow: body.flow,
        relatedFlows: Array.isArray(body.relatedFlows) ? body.relatedFlows.filter(isFlow) : undefined,
        nodeId: body.nodeId,
        modelId: body.modelId,
        draftPrompt: typeof body.draftPrompt === 'string' ? body.draftPrompt : undefined,
      }));
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

export const POST = withWorkspaceRoute(POST_handler);
