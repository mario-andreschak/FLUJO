import { getModelConfigurationCapabilities, validateModelConfiguration } from '@/shared/types/model/provider';

describe('provider-aware model configuration capabilities (#329)', () => {
  it('offers the Antigravity CLI effort vocabulary only where the CLI accepts --effort', () => {
    // `default` and names that already carry a level are refused by the CLI with --effort.
    for (const name of ['default', '', 'gemini-3.1-pro-high', 'gemini-3.8-flash-low']) {
      expect(getModelConfigurationCapabilities('antigravity-cli', 'antigravity-cli', name))
        .toEqual({ maxOutputTokens: false });
    }
    expect(getModelConfigurationCapabilities('antigravity-cli', undefined, 'default'))
      .toEqual({ maxOutputTokens: false });
    // The editor narrows this to the levels `agy models` lists; the CLI refuses others.
    for (const name of ['gemini-3.1-pro', 'custom-model']) {
      expect(getModelConfigurationCapabilities('antigravity-cli', 'antigravity-cli', name))
        .toEqual({ effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], maxOutputTokens: false });
    }
    const antigravity = { provider: 'antigravity-cli' as const, adapter: 'antigravity-cli' as const };
    expect(validateModelConfiguration({ ...antigravity, name: 'gemini-3.1-pro', reasoningEffort: 'high' })).toBeUndefined();
    expect(validateModelConfiguration({ ...antigravity, name: 'gemini-3.1-pro-high', reasoningEffort: 'low' })).toMatch(/not supported/);
    expect(validateModelConfiguration({ ...antigravity, name: 'default', reasoningEffort: 'high' })).toMatch(/not supported/);
    expect(validateModelConfiguration({ ...antigravity, name: 'gemini-3.1-pro', reasoningEffort: 'ultra' })).toMatch(/not supported/);
    expect(validateModelConfiguration({ ...antigravity, name: 'gemini-3.1-pro', temperature: '0.2' })).toMatch(/not supported/);
  });
  it('exposes effort and priority for Codex while hiding sampling/output caps', () => {
    expect(getModelConfigurationCapabilities('codex', 'codex-cli', 'gpt-6-astra')).toEqual({
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      priority: true,
      maxOutputTokens: false,
    });
    expect(getModelConfigurationCapabilities('codex', 'codex-cli', 'gpt-5.6-sol')).toEqual({
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      priority: true,
      maxOutputTokens: false,
    });

    expect(
      getModelConfigurationCapabilities('codex', 'codex-cli', 'gpt-5.4-mini').priority
    ).toBe(false);
  });

  it('uses Interactions thinking levels including Argon', () => {
    expect(
      getModelConfigurationCapabilities('gemini', 'gemini', 'gemini-2.5-pro')
    ).toMatchObject({ thinkingLevels: ['minimal', 'low', 'medium', 'high'], maxOutputTokens: true });

    for (const model of ['gemini-3.1-pro-preview', 'gemini-3.5-flash-lite']) {
      expect(
        getModelConfigurationCapabilities('gemini', 'gemini', model)
      ).toMatchObject({
        thinkingLevels: ['minimal', 'low', 'medium', 'high'],
        maxOutputTokens: true,
      });
    }

    for (const model of ['gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-4-argon']) {
      expect(
        getModelConfigurationCapabilities('gemini', 'gemini', model)
      ).toMatchObject({
        thinkingLevels: ['low', 'medium', 'high'],
        maxOutputTokens: true,
      });
    }
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

  it('offers no Creativity on the Anthropic Messages format, for any model, and keeps a saved one', () => {
    for (const name of ['claude-3-5-sonnet-20241022', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-5-5']) {
      const capabilities = getModelConfigurationCapabilities('anthropic', 'anthropic', name);
      expect(capabilities.creativity).toBeUndefined();
      expect(capabilities.keepsUnusedCreativity).toBe(true);
    }
    // The OpenAI-format Anthropic profile is a different request format and keeps its control.
    expect(getModelConfigurationCapabilities('anthropic', 'openai', 'claude-sonnet-4-6').creativity).toBeDefined();
  });

  it('offers creativity to ordinary request/response models', () => {
    expect(
      getModelConfigurationCapabilities('openrouter', 'openai', 'vendor/model').creativity
    ).toEqual({ min: 0, max: 2, step: 0.1 });
  });

  it('accepts medium effort for native and OpenRouter Opus 5.5 Messages models', () => {
    for (const name of ['claude-opus-5-5', 'anthropic/claude-opus-5.5', 'anthropic/claude-opus-4.8']) {
      const model = { provider: 'openrouter' as const, adapter: 'anthropic' as const, name, reasoningEffort: 'medium' };
      expect(validateModelConfiguration(model)).toBeUndefined();
      expect(getModelConfigurationCapabilities(model.provider, model.adapter, name).creativity).toBeUndefined();
    }
  });

  it('maps the Agent SDK effort controls to its supported request values', () => {
    const model = { provider: 'openrouter' as const, adapter: 'openrouter-agent' as const,
      name: 'anthropic/claude-opus-5.5', reasoningEffort: 'medium' };
    expect(validateModelConfiguration(model)).toBeUndefined();
    expect(validateModelConfiguration({ ...model, reasoningEffort: 'ultra' })).toBeDefined();
    expect(getModelConfigurationCapabilities(model.provider, model.adapter, model.name).creativity).toBeUndefined();
  });
});
