import { getModelConfigurationCapabilities } from '@/shared/types/model/provider';

describe('provider-aware model configuration capabilities (#329)', () => {
  it('exposes effort and priority for Codex while hiding sampling/output caps', () => {
    expect(getModelConfigurationCapabilities('codex', 'codex-cli', 'gpt-5.6-sol')).toEqual({
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      priority: true,
      maxOutputTokens: false,
    });

    expect(
      getModelConfigurationCapabilities('codex', 'codex-cli', 'gpt-5.4-mini').priority
    ).toBe(false);
  });

  it('uses a token budget for Gemini 2.5 and thinking levels for Gemini 3+', () => {
    expect(
      getModelConfigurationCapabilities('gemini', 'gemini', 'gemini-2.5-pro')
    ).toMatchObject({ thinkingBudget: true, maxOutputTokens: true });
    expect(
      getModelConfigurationCapabilities('gemini', 'gemini', 'gemini-3.1-pro-preview')
    ).toMatchObject({
      thinkingLevels: ['minimal', 'low', 'medium', 'high'],
      maxOutputTokens: true,
    });
  });

  it('replaces creativity with effort on known reasoning/adaptive models', () => {
    const openAI = getModelConfigurationCapabilities('openai', 'openai-responses', 'gpt-5');
    expect(openAI.creativity).toBeUndefined();
    expect(openAI.effortLevels).toEqual(['low', 'medium', 'high']);

    const claude = getModelConfigurationCapabilities(
      'anthropic',
      'anthropic',
      'claude-opus-4-8'
    );
    expect(claude.creativity).toBeUndefined();
    expect(claude.effortLevels).toContain('max');
  });

  it('offers creativity to ordinary request/response models', () => {
    expect(
      getModelConfigurationCapabilities('openrouter', 'openai', 'vendor/model').creativity
    ).toEqual({ min: 0, max: 2, step: 0.1 });
  });
});
