import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createJsonEventStreamResponse } from '@/backend/utils/jsonEventStream';
import { generateFlowVisually } from '@/backend/services/flow/visualGeneration';
import {
  MAX_VISUAL_GENERATION_DEPTH,
  type StartVisualGenerationInput,
  type VisualGenerationEvent,
} from '@/shared/types/flow/visualGeneration';
import { json } from '../../_helpers';

/** Stream an unsaved visual authoring session as typed NDJSON events. */
async function POST_handler(request: NextRequest) {
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;
  const body = await request.json().catch(() => null) as Partial<StartVisualGenerationInput> | null;
  if (!body || typeof body !== 'object') return json({ error: 'Request body must be a JSON object' }, 400);
  if (typeof body.description !== 'string' || !body.description.trim()) {
    return json({ error: 'A workflow description is required' }, 400);
  }
  if (typeof body.modelId !== 'string' || !body.modelId) {
    return json({ error: 'A generator model id is required' }, 400);
  }
  const input: StartVisualGenerationInput = {
    description: body.description,
    modelId: body.modelId,
    maxDepth: typeof body.maxDepth === 'number'
      ? Math.max(1, Math.min(MAX_VISUAL_GENERATION_DEPTH, Math.floor(body.maxDepth)))
      : MAX_VISUAL_GENERATION_DEPTH,
    allowInstall: body.allowInstall === true,
  };
  return createJsonEventStreamResponse<VisualGenerationEvent>(
    (emit, signal) => generateFlowVisually(input, emit, signal),
    (error) => ({ type: 'error', error }),
    { signal: request.signal },
  );
}

export const POST = withWorkspaceRoute(POST_handler);
