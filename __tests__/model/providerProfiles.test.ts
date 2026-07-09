import {
  PROVIDER_PROFILES,
  getProviderProfile,
  getProviderProfileById,
} from '@/shared/types/model/provider';

describe('provider profiles', () => {
  it('exposes the expected set of profiles and hides Mistral', () => {
    const ids = PROVIDER_PROFILES.map(p => p.id);
    expect(ids).toEqual([
      'openai',
      'openrouter',
      'xai',
      'ollama',
      'litellm',
      'gemini-openai',
      'gemini-native',
      'anthropic-openai',
      'anthropic-native',
      'claude-subscription',
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
    expect(getProviderProfile('openrouter', 'openai').id).toBe('openrouter');
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
    expect(getProviderProfileById('gemini-native')?.showBaseUrl).toBe(false);
    expect(getProviderProfileById('anthropic-native')?.showBaseUrl).toBe(false);
    expect(getProviderProfileById('claude-subscription')?.showBaseUrl).toBe(false);
    expect(getProviderProfileById('claude-subscription')?.sdkLabel).toBe('Claude CLI');
    expect(getProviderProfileById('gemini-native')?.sdkLabel).toBe('GenAI SDK');
  });
});
