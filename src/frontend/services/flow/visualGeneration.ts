'use client';

import type {
  StartVisualGenerationInput,
  VisualGenerationEvent,
  VisualGenerationResult,
} from '@/shared/types/flow/visualGeneration';
import { readJsonEventStream } from '@/frontend/utils/jsonEventReader';

export async function startVisualGeneration(
  input: StartVisualGenerationInput,
  onEvent: (event: VisualGenerationEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<VisualGenerationResult> {
  const response = await fetch('/api/flow/generate/visual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || 'Could not start visual agent generation.');
  }
  let result: VisualGenerationResult | null = null;
  let streamError: string | null = null;
  await readJsonEventStream<VisualGenerationEvent>(response, async (event) => {
    await onEvent(event);
    if (event.type === 'complete') result = event.result;
    if (event.type === 'error') streamError = event.error;
  });
  if (streamError) throw new Error(streamError);
  if (!result) throw new Error('Visual generation ended without a completed draft.');
  return result;
}
