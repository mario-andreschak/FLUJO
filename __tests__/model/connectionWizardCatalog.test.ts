import { buildGuidedModels } from '@/frontend/components/models/connectionWizardCatalog';

describe('guided model bundles', () => {
  it('uses OpenRouter’s exact free-router technical name', () => {
    const models = buildGuidedModels({ kind: 'openrouter-free', apiKey: 'secret' });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      name: 'openrouter/free',
      provider: 'openrouter',
      adapter: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      ApiKey: 'secret',
    });
  });

  it('creates the full Claude subscription bundle with one setup token', () => {
    const models = buildGuidedModels({ kind: 'claude-subscription', apiKey: 'oauth-token' });

    expect(models.map((model) => model.name)).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(models.every((model) => model.adapter === 'claude-cli')).toBe(true);
    expect(models.every((model) => model.ApiKey === 'oauth-token')).toBe(true);
  });

  it('creates keyless Codex models for the local ChatGPT login', () => {
    const models = buildGuidedModels({ kind: 'codex-subscription' });

    expect(models.map((model) => model.name)).toEqual(['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.4-mini']);
    expect(models.every((model) => model.provider === 'codex' && model.ApiKey === '')).toBe(true);
  });

  it('normalizes an Ollama server root to its OpenAI-compatible endpoint', () => {
    const [model] = buildGuidedModels({
      kind: 'ollama',
      ollamaModel: 'qwen2.5:7b',
      ollamaUrl: 'http://localhost:11434/',
    });

    expect(model).toMatchObject({
      name: 'qwen2.5:7b',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      ApiKey: 'ollama',
    });
  });
});
