import {
  GEMINI_NATIVE_FALLBACK_MODELS,
  PROVIDER_PROFILES,
  getProviderProfile,
  getProviderProfileById,
  supportsProviderModelDiscovery,
  resolveModelAdapter,
  isSelfOrchestratingAdapter,
  supportsLocalModelAuth,
  ANTIGRAVITY_CLI_API_KEY_MODELS,
} from '@/shared/types/model/provider';

describe('provider profiles', () => {
  it('exposes the expected set of profiles and hides Mistral', () => {
    const ids = PROVIDER_PROFILES.map(p => p.id);
    expect(ids).toEqual([
      'openai-responses',
      'azure',
      'openrouter',
      'requesty',
      'xai',
      'ollama',
      'litellm',
      'gemini-openai',
      'gemini-native',
      'anthropic-openai',
      'anthropic-native',
      'claude-subscription',
      'codex',
      'antigravity-cli',
      'openai',
    ]);
    // Mistral must not be selectable in the modal.
    expect(PROVIDER_PROFILES.some(p => p.provider === 'mistral')).toBe(false);
  });

  it('maps provider+adapter pairs to the right profile', () => {
    expect(getProviderProfile('gemini', 'gemini').id).toBe('gemini-native');
    expect(getProviderProfile('gemini', 'openai').id).toBe('gemini-openai');
    expect(getProviderProfile('anthropic', 'anthropic').id).toBe('anthropic-native');
    expect(getProviderProfile('anthropic', 'openai').id).toBe('anthropic-openai');
    expect(getProviderProfile('claude-subscription', 'claude-cli').id).toBe('claude-subscription');
    expect(getProviderProfile('codex', 'codex-cli').id).toBe('codex');
    expect(getProviderProfile('antigravity-cli', 'antigravity-cli').id).toBe('antigravity-cli');
    expect(getProviderProfile('openrouter', 'openai').id).toBe('openrouter');
    expect(getProviderProfile('requesty', 'openai').id).toBe('requesty');
    expect(getProviderProfile('openai', 'openai-responses').id).toBe('openai-responses');
    expect(getProviderProfile('azure', 'azure').id).toBe('azure');
  });

  it('does not let the Responses profile shadow plain OpenAI', () => {
    // Both profiles share provider 'openai', so resolution must key on the adapter.
    // The legacy profile stays the answer for adapter 'openai'
    // and for legacy models with no adapter at all.
    expect(getProviderProfile('openai', 'openai').id).toBe('openai');
    expect(getProviderProfile('openai', undefined).id).toBe('openai');
  });

  it('puts legacy OpenAI last and uses Responses for gateway profiles and saved connections', () => {
    expect(PROVIDER_PROFILES.at(-1)).toMatchObject({ id: 'openai', label: 'OpenAI ChatCompletions (Legacy)' });
    for (const provider of ['requesty', 'openrouter'] as const) {
      expect(getProviderProfileById(provider)?.adapter).toBe('openai-responses');
      for (const adapter of [undefined, 'openai', 'openai-responses'] as const) {
        expect(resolveModelAdapter(provider, adapter)).toBe('openai-responses');
        expect(getProviderProfile(provider, adapter).adapter).toBe('openai-responses');
      }
    }
    expect(resolveModelAdapter('openai', 'openai')).toBe('openai');
    expect(resolveModelAdapter('ollama', undefined)).toBe('openai');
  });

  it('defaults legacy models (no adapter) to the OpenAI-compatible profile', () => {
    // Models saved before the adapter field existed.
    expect(getProviderProfile('openai', undefined).id).toBe('openai');
    expect(getProviderProfile(undefined, undefined).id).toBe('openai');
    // A provider with no exact adapter match still resolves to that provider.
    expect(getProviderProfile('gemini', undefined).provider).toBe('gemini');
  });

  it('flags base-URL visibility and SDK label per profile', () => {
    expect(getProviderProfileById('openai')?.showBaseUrl).toBe(true);
    expect(getProviderProfileById('azure')).toMatchObject({
      showBaseUrl: true,
      supportsModelDiscovery: false,
      defaultApiVersion: '2024-10-21',
      sdkLabel: 'AzureOpenAI SDK',
    });
    expect(getProviderProfileById('gemini-native')?.showBaseUrl).toBe(false);
    expect(getProviderProfileById('anthropic-native')).toMatchObject({
      showBaseUrl: true,
      supportsModelDiscovery: false,
      baseUrl: '',
      sdkLabel: 'Anthropic SDK',
    });
    expect(getProviderProfileById('claude-subscription')?.showBaseUrl).toBe(false);
    expect(getProviderProfileById('claude-subscription')?.sdkLabel).toBe('Claude CLI');
    expect(getProviderProfileById('gemini-native')?.sdkLabel).toBe('GenAI SDK');
    expect(getProviderProfileById('codex')?.showBaseUrl).toBe(false);
    expect(getProviderProfileById('codex')?.sdkLabel).toBe('Codex SDK');
  });

  it('discovers native Gemini without a base URL and keeps current stable fallbacks', () => {
    const nativeGemini = getProviderProfileById('gemini-native');
    expect(nativeGemini).toMatchObject({
      showBaseUrl: false,
      supportsModelDiscovery: true,
      baseUrl: '',
      defaultModels: GEMINI_NATIVE_FALLBACK_MODELS,
    });
    expect(supportsProviderModelDiscovery(nativeGemini!, '')).toBe(true);
    expect(supportsProviderModelDiscovery(getProviderProfileById('openai')!, '')).toBe(false);
    expect(supportsProviderModelDiscovery(
      getProviderProfileById('openai')!,
      'https://api.openai.com/v1',
    )).toBe(true);
    expect(GEMINI_NATIVE_FALLBACK_MODELS).toEqual(expect.arrayContaining([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ]));
    expect(GEMINI_NATIVE_FALLBACK_MODELS).not.toContain('gemini-2.0-flash');
  });

  it('offers the current Codex CLI model catalog', () => {
    expect(getProviderProfileById('codex')?.defaultModels).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
  });

  it('keeps Antigravity CLI local authentication separate from native Gemini', () => {
    expect(getProviderProfileById('antigravity-cli')).toMatchObject({
      provider: 'antigravity-cli', adapter: 'antigravity-cli', sdkLabel: 'Antigravity CLI',
      baseUrl: '', showBaseUrl: false, supportsModelDiscovery: false,
      defaultModels: [
        'default',
        'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
        'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
        'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
        'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
        'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
      ],
    });
    expect(resolveModelAdapter('antigravity-cli')).toBe('antigravity-cli');
    expect(getProviderProfile('antigravity-cli').id).toBe('antigravity-cli');
    expect(supportsProviderModelDiscovery(getProviderProfileById('antigravity-cli')!, '')).toBe(false);
    for (const adapter of ['codex-cli', 'antigravity-cli']) {
      expect(supportsLocalModelAuth(adapter)).toBe(true);
      expect(isSelfOrchestratingAdapter(adapter)).toBe(true);
    }
    for (const adapter of [undefined, 'gemini', 'gemini-cli', 'openai', 'claude-cli']) {
      expect(supportsLocalModelAuth(adapter)).toBe(false);
    }
    expect(isSelfOrchestratingAdapter('gemini')).toBe(false);
  });

  it('suggests only the verified Gemini slugs for Antigravity API-key mode', () => {
    expect(ANTIGRAVITY_CLI_API_KEY_MODELS).toEqual([
      'default',
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
      'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
      'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
      'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    ]);
  });
});
