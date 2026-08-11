import {
  normalizeModelTemperature,
  validateModelConfiguration,
} from '@/shared/types/model/provider';

/**
 * Issue #329 — persisted-value hardening. The modal already hides controls the
 * selected provider/model does not support, but the REST API and hand-authored
 * `db/models.json` entries bypass it, so the same capability contract has to
 * hold on the persistence and execution paths.
 */
describe('generation settings validation (#329)', () => {
  it('accepts creativity inside the provider range and rejects it outside', () => {
    expect(validateModelConfiguration({
      provider: 'openrouter', adapter: 'openai', name: 'vendor/model', temperature: '1.4',
    })).toBeUndefined();

    expect(validateModelConfiguration({
      provider: 'openrouter', adapter: 'openai', name: 'vendor/model', temperature: '2.5',
    })).toMatch(/between 0 and 2/);

    expect(validateModelConfiguration({
      provider: 'anthropic', adapter: 'anthropic', name: 'claude-3-5-sonnet', temperature: 1.5,
    })).toMatch(/between 0 and 1/);

    expect(validateModelConfiguration({
      provider: 'openrouter', adapter: 'openai', name: 'vendor/model', temperature: 'hot',
    })).toMatch(/Creativity/);
  });

  it('rejects creativity for models that expose effort instead', () => {
    expect(validateModelConfiguration({
      provider: 'openai', adapter: 'openai-responses', name: 'gpt-5', temperature: '0.7',
    })).toMatch(/not supported/);
  });

  it('rejects an effort level the selected model does not advertise', () => {
    expect(validateModelConfiguration({
      provider: 'openai', adapter: 'openai-responses', name: 'gpt-5', reasoningEffort: 'high',
    })).toBeUndefined();

    expect(validateModelConfiguration({
      provider: 'openai', adapter: 'openai-responses', name: 'gpt-5', reasoningEffort: 'ultra',
    })).toMatch(/reasoning effort is not supported/);

    // An ordinary OpenAI-compatible endpoint has no portable reasoning field.
    expect(validateModelConfiguration({
      provider: 'openrouter', adapter: 'openai', name: 'vendor/model', reasoningEffort: 'high',
    })).toMatch(/reasoning effort is not supported/);
  });

  it('keeps the two Gemini thinking controls apart', () => {
    expect(validateModelConfiguration({
      provider: 'gemini', adapter: 'gemini', name: 'gemini-2.5-pro', thinkingBudget: 1024,
    })).toBeUndefined();

    expect(validateModelConfiguration({
      provider: 'gemini', adapter: 'gemini', name: 'gemini-2.5-pro', thinkingLevel: 'high',
    })).toMatch(/thinking level is not supported/);

    expect(validateModelConfiguration({
      provider: 'gemini', adapter: 'gemini', name: 'gemini-3.1-pro-preview', thinkingLevel: 'high',
    })).toBeUndefined();

    expect(validateModelConfiguration({
      provider: 'gemini', adapter: 'gemini', name: 'gemini-3.1-pro-preview', thinkingBudget: 1024,
    })).toMatch(/Thinking budget/);
  });

  it('rejects a malformed thinking budget on a budget-capable model', () => {
    for (const thinkingBudget of [-2, 12.5, '1024']) {
      expect(validateModelConfiguration({
        provider: 'gemini', adapter: 'gemini', name: 'gemini-2.5-flash', thinkingBudget,
      })).toMatch(/Thinking budget/);
    }
    expect(validateModelConfiguration({
      provider: 'gemini', adapter: 'gemini', name: 'gemini-2.5-flash', thinkingBudget: -1,
    })).toBeUndefined();
  });

  it('only allows the Codex priority tier where the runtime offers it', () => {
    expect(validateModelConfiguration({
      provider: 'codex', adapter: 'codex-cli', name: 'gpt-5.6-sol', serviceTier: 'priority',
    })).toBeUndefined();

    expect(validateModelConfiguration({
      provider: 'codex', adapter: 'codex-cli', name: 'gpt-5.6-sol', serviceTier: 'turbo',
    })).toMatch(/service tier is not supported/);

    expect(validateModelConfiguration({
      provider: 'codex', adapter: 'codex-cli', name: 'gpt-5.4-mini', serviceTier: 'priority',
    })).toMatch(/service tier is not supported/);

    expect(validateModelConfiguration({
      provider: 'openai', adapter: 'openai', name: 'gpt-4o', serviceTier: 'priority',
    })).toMatch(/service tier is not supported/);
  });

  it('treats absent and empty generation settings as untouched', () => {
    expect(validateModelConfiguration({
      provider: 'openai', adapter: 'openai', name: 'gpt-4o',
      temperature: '', reasoningEffort: '', thinkingLevel: '', thinkingBudget: '', serviceTier: '',
    })).toBeUndefined();
    expect(validateModelConfiguration({ provider: 'openai', adapter: 'openai', name: 'gpt-4o' }))
      .toBeUndefined();
  });

  it('requires a valid HTTPS endpoint and API version for Azure', () => {
    expect(validateModelConfiguration({
      provider: 'azure', adapter: 'azure', name: 'deployment',
      baseUrl: 'https://team.openai.azure.com', azureApiVersion: '2024-10-21',
    })).toBeUndefined();
    expect(validateModelConfiguration({
      provider: 'azure', adapter: 'azure', name: 'deployment', azureApiVersion: '2024-10-21',
    })).toMatch(/endpoint is required/);
    expect(validateModelConfiguration({
      provider: 'azure', adapter: 'azure', name: 'deployment',
      baseUrl: 'http://team.openai.azure.com', azureApiVersion: '2024-10-21',
    })).toMatch(/must use HTTPS/);
    expect(validateModelConfiguration({
      provider: 'azure', adapter: 'azure', name: 'deployment',
      baseUrl: 'https://team.openai.azure.com',
    })).toMatch(/API version is required/);
    expect(validateModelConfiguration({
      provider: 'azure', adapter: 'azure', name: '',
      baseUrl: 'https://team.openai.azure.com', azureApiVersion: '2024-10-21',
    })).toMatch(/deployment name is required/);
  });
});

describe('persisted creativity normalization (#329)', () => {
  it('parses stored strings and clamps into the provider range', () => {
    expect(normalizeModelTemperature('0.7', 'openrouter', 'openai', 'vendor/model')).toBe(0.7);
    expect(normalizeModelTemperature(9, 'openrouter', 'openai', 'vendor/model')).toBe(2);
    expect(normalizeModelTemperature(-3, 'anthropic', 'anthropic', 'claude-3-5-sonnet')).toBe(0);
    expect(normalizeModelTemperature(5, 'anthropic', 'anthropic', 'claude-3-5-sonnet')).toBe(1);
  });

  it('drops values that must never reach a provider SDK', () => {
    expect(normalizeModelTemperature('', 'openai', 'openai', 'gpt-4o')).toBeUndefined();
    expect(normalizeModelTemperature(undefined, 'openai', 'openai', 'gpt-4o')).toBeUndefined();
    expect(normalizeModelTemperature('warm', 'openai', 'openai', 'gpt-4o')).toBeUndefined();
    expect(normalizeModelTemperature(NaN, 'openai', 'openai', 'gpt-4o')).toBeUndefined();
    expect(normalizeModelTemperature({}, 'openai', 'openai', 'gpt-4o')).toBeUndefined();
    // Stale value left on a model that was switched to a reasoning profile.
    expect(normalizeModelTemperature('0.7', 'openai', 'openai-responses', 'gpt-5')).toBeUndefined();
    expect(normalizeModelTemperature('0.7', 'codex', 'codex-cli', 'gpt-5.6-sol')).toBeUndefined();
  });
});
