import type { Model } from '@/shared/types/model';

export type OpenRouterMediaKind = 'images' | 'videos';

export interface OpenRouterMediaRoute {
  /** True only when the model is reachable *exclusively* through a dedicated media endpoint. */
  useMediaRoute: boolean;
  /** Which dedicated endpoint applies, when useMediaRoute is true. */
  kind?: OpenRouterMediaKind;
  /** Short human-readable justification, surfaced in the model card test. */
  reason: string;
}

/**
 * Normalize a model's `outputModalities` into a lowercased, trimmed, string
 * array, tolerant of `undefined`/stale/non-string entries.
 */
export function normalizeOutputModalities(model: Pick<Model, 'outputModalities'>): string[] {
  return (model.outputModalities ?? [])
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Single source of truth for whether an OpenRouter model must be routed to
 * the dedicated `/images` or `/videos` media endpoints rather than
 * `/chat/completions`.
 *
 * A model is routed to the media endpoints only when it is *media-only*:
 * its output modalities include `image`/`video` but do NOT include `text`.
 * Models that also emit text (ordinary multimodal chat models) are served by
 * Chat Completions, which already supports requesting image output via
 * `modalities: ["image","text"]` (see openaiAdapter.ts).
 *
 * Used by both the execution path (getCompletionAdapter, the media adapter
 * itself) and the model-card test path (testConnection.ts) so the two can
 * never disagree.
 */
export function resolveOpenRouterMediaRoute(model: Model): OpenRouterMediaRoute {
  if (model.provider !== 'openrouter') {
    return { useMediaRoute: false, reason: 'not an OpenRouter model' };
  }

  if (model.adapter && model.adapter !== 'openai') {
    return {
      useMediaRoute: false,
      reason: `explicit ${model.adapter} adapter pinned on the model`,
    };
  }

  const outputs = normalizeOutputModalities(model);

  if (outputs.length === 0) {
    return {
      useMediaRoute: false,
      reason: 'no output modality metadata; defaulting to Chat Completions',
    };
  }

  if (outputs.includes('text')) {
    return {
      useMediaRoute: false,
      reason: 'model also emits text, so it is served by /chat/completions',
    };
  }

  if (outputs.includes('video')) {
    return { useMediaRoute: true, kind: 'videos', reason: 'video-only OpenRouter model' };
  }

  if (outputs.includes('image')) {
    return { useMediaRoute: true, kind: 'images', reason: 'image-only OpenRouter model' };
  }

  return {
    useMediaRoute: false,
    reason: `no dedicated OpenRouter route for output modalities [${outputs.join(', ')}]`,
  };
}
