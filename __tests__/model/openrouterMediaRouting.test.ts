/**
 * Regression suite for issue #370 — "OpenRouter Adapter: Media Route issue".
 *
 * Bug: every OpenRouter model whose catalogue metadata advertised `image` or
 * `video` in `outputModalities` was unconditionally routed to the dedicated
 * `/images` / `/videos` endpoints. Ordinary multimodal *chat* models
 * (`outputModalities: ["text","image"]`) are not served there, so every chat
 * invocation failed while the model-card test — which used a different code
 * path — still reported success.
 *
 * Fix: one shared predicate, `resolveOpenRouterMediaRoute()`, that selects the
 * media route only for *media-only* models, consumed by BOTH the execution path
 * (`getCompletionAdapter`) and the model-card diagnostics
 * (`describeCompletionAdapter`, used by testConnection.ts).
 *
 * This file pins the predicate itself plus the "test green / chat red"
 * divergence guard: the two consumers must never disagree.
 */
import type { Model } from '@/shared/types/model';
import {
  AnthropicAdapter,
  ClaudeSubscriptionAdapter,
  CodexAdapter,
  GeminiAdapter,
  OpenAiAdapter,
  OpenAiResponsesAdapter,
  OpenRouterMediaAdapter,
  describeCompletionAdapter,
  getCompletionAdapter,
  normalizeOutputModalities,
  resolveOpenRouterMediaRoute,
} from '@/backend/services/model/adapters';

type OutputModality = NonNullable<Model['outputModalities']>[number];

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'model-1',
    name: 'openrouter/some-model',
    ApiKey: 'encrypted',
    provider: 'openrouter',
    adapter: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    inputModalities: ['text'],
    outputModalities: ['text'],
    ...overrides,
  } as Model;
}

const withOutputs = (outputs: readonly OutputModality[] | undefined, overrides: Partial<Model> = {}) =>
  makeModel({ outputModalities: outputs ? [...outputs] : undefined, ...overrides });

describe('resolveOpenRouterMediaRoute (#370)', () => {
  it('never routes non-OpenRouter models to the media endpoints', () => {
    for (const provider of ['openai', 'anthropic', 'gemini', 'mistral'] as const) {
      const route = resolveOpenRouterMediaRoute(withOutputs(['image'], { provider }));
      expect(route).toMatchObject({ useMediaRoute: false });
      expect(route.reason).toMatch(/not an OpenRouter model/i);
    }
  });

  it('respects an explicitly pinned non-OpenAI adapter', () => {
    const route = resolveOpenRouterMediaRoute(withOutputs(['image'], { adapter: 'anthropic' }));
    expect(route.useMediaRoute).toBe(false);
    expect(route.reason).toMatch(/anthropic/);
  });

  it('falls back to chat completions when modality metadata is missing or stale', () => {
    for (const outputs of [undefined, [] as OutputModality[]]) {
      const route = resolveOpenRouterMediaRoute(withOutputs(outputs));
      expect(route.useMediaRoute).toBe(false);
    }
    // Stale records that only carry junk entries must not be routed to media.
    const junk = resolveOpenRouterMediaRoute(
      makeModel({ outputModalities: [null, 42, '   '] as unknown as string[] }),
    );
    expect(junk.useMediaRoute).toBe(false);
  });

  it.each([
    [['text']],
    [['text', 'image']],
    [['text', 'video']],
    [['image', 'text']],
    [['TEXT', ' Image ']],
  ] as const)('keeps text-emitting OpenRouter model %j on /chat/completions', (outputs) => {
    const route = resolveOpenRouterMediaRoute(withOutputs(outputs as unknown as OutputModality[]));
    expect(route.useMediaRoute).toBe(false);
    expect(route.kind).toBeUndefined();
  });

  it('routes media-only models to their dedicated endpoint', () => {
    expect(resolveOpenRouterMediaRoute(withOutputs(['image']))).toMatchObject({
      useMediaRoute: true,
      kind: 'images',
    });
    expect(resolveOpenRouterMediaRoute(withOutputs(['video']))).toMatchObject({
      useMediaRoute: true,
      kind: 'videos',
    });
    // Video wins when a model advertises both media kinds but no text.
    expect(resolveOpenRouterMediaRoute(withOutputs(['image', 'video']))).toMatchObject({
      useMediaRoute: true,
      kind: 'videos',
    });
  });

  it('is case- and whitespace-insensitive about modality metadata', () => {
    expect(normalizeOutputModalities({ outputModalities: [' Image ', 'VIDEO', ''] })).toEqual(['image', 'video']);
    expect(normalizeOutputModalities({ outputModalities: undefined })).toEqual([]);
    expect(resolveOpenRouterMediaRoute(withOutputs([' IMAGE '] as unknown as OutputModality[]))).toMatchObject({
      useMediaRoute: true,
      kind: 'images',
    });
  });

  it('always explains its decision so the model card can show it', () => {
    for (const outputs of [['text'], ['image'], ['video'], ['audio']] as const) {
      expect(resolveOpenRouterMediaRoute(withOutputs(outputs as unknown as OutputModality[])).reason)
        .toEqual(expect.any(String));
    }
  });
});

describe('adapter selection stays in sync with its description (#370)', () => {
  const expectedConstructor: Record<string, unknown> = {
    'openrouter-media': OpenRouterMediaAdapter,
    'openai': OpenAiAdapter,
    'openai-responses': OpenAiResponsesAdapter,
    'anthropic': AnthropicAdapter,
    'gemini': GeminiAdapter,
    'claude-cli': ClaudeSubscriptionAdapter,
    'codex-cli': CodexAdapter,
  };

  const candidates: Model[] = [
    withOutputs(['image']),
    withOutputs(['video']),
    withOutputs(['text', 'image']),
    withOutputs(undefined),
    withOutputs(['image'], { provider: 'openai' }),
    ...(['openai', 'openai-responses', 'anthropic', 'gemini', 'claude-cli', 'codex-cli'] as const).map((adapter) =>
      withOutputs(['text'], { adapter }),
    ),
    ...(['anthropic', 'gemini', 'claude-cli', 'codex-cli'] as const).map((adapter) =>
      withOutputs(['image'], { adapter }),
    ),
  ];

  const cases: Array<[string, Model]> = candidates.map((model) => [
    `${model.provider}/${model.adapter}/${(model.outputModalities ?? []).join('+') || 'none'}`,
    model,
  ]);

  it.each(cases)(
    'describeCompletionAdapter matches getCompletionAdapter for %s',
    (_label, model) => {
      const described = describeCompletionAdapter(model);
      expect(getCompletionAdapter(model)).toBeInstanceOf(
        expectedConstructor[described.adapterId] as new () => unknown,
      );
    },
  );

  it('reports the endpoint the user will actually hit', () => {
    expect(describeCompletionAdapter(withOutputs(['text', 'image']))).toMatchObject({
      adapterId: 'openai',
      endpoint: '/chat/completions',
    });
    expect(describeCompletionAdapter(withOutputs(['image']))).toMatchObject({
      adapterId: 'openrouter-media',
      endpoint: '/images',
    });
    expect(describeCompletionAdapter(withOutputs(['video']))).toMatchObject({
      adapterId: 'openrouter-media',
      endpoint: '/videos',
    });
  });
});
