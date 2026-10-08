import { installPrivateProfileFixture } from '../utils/privateProfileFixture';
let privateFixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
afterEach(async () => { await privateFixture?.restore(); });
/**
 * Tests for issue #53 — exposing configured FLUJO models on /v1/models and the
 * single-turn ModelService.generateChatCompletion used by /v1/chat/completions
 * for `model-<identifier>` requests.
 *
 * Covers:
 *  - /v1/models lists flow- AND model- entries with a strict id/object
 *    whitelist (secret-leak scan), dedupes repeated ids, and degrades to
 *    flows-only when model storage fails.
 *  - identifier resolution: displayName first, technical-name fallback,
 *    case-insensitivity, model_not_found (404), model_ambiguous (400).
 *  - the adapter receives the decrypted key + resolved model; the returned
 *    completion is OpenAI-shaped with the public `model-` id.
 *  - provider errors (in-band and thrown) are sanitized: no raw provider
 *    payload, no API key, no model internals in what is returned.
 *  - claude-cli + client tools is rejected instead of silently diverging.
 */
import type { Model } from '@/shared/types/model';

// In-memory storage so the backend service never touches disk.
const store: Record<string, unknown> = {};
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async (key: string, val: unknown) => { store[key] = val; }),
  loadItem: jest.fn(async (key: string, fallback: unknown) => {
    if (store.__throwOnLoad === key) throw new Error('storage exploded');
    return key in store ? store[key] : fallback;
  }),
}));

// Deterministic, crypto-free encryption so key handling can be asserted.
jest.mock('@/backend/services/model/encryption', () => ({
  encryptApiKey: jest.fn(async (k: string) => `encrypted:${k}`),
  decryptApiKey: jest.fn(async (k: string) => k),
  resolveAndDecryptApiKey: jest.fn(async (k: string) => (k ? k.replace(/^encrypted:/, '') : null)),
  isEncryptionConfigured: jest.fn(async () => true),
  isUserEncryptionEnabled: jest.fn(async () => false),
  setEncryptionKey: jest.fn(async () => ({ success: true })),
  initializeDefaultEncryption: jest.fn(async () => true),
}));

// The completion-adapter seam is mocked; these tests assert what crosses it.
const mockCreateCompletion = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: jest.fn(() => ({ createCompletion: mockCreateCompletion })),
}));
jest.mock('@/backend/services/model/testConnection', () => ({ testModelConnection: jest.fn() }));

import { modelService } from '@/backend/services/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { resolveAndDecryptApiKey } from '@/backend/services/model/encryption';
import { testModelConnection } from '@/backend/services/model/testConnection';
import { GET as listModels } from '@/app/v1/models/route';
import { StorageKey } from '@/shared/types/storage';

const SECRET = 'sk-super-secret-key-123';

const modelFixture = (over: Partial<Model> = {}): Model => ({
  id: 'm1',
  name: 'gpt-test',
  displayName: 'GPT Test',
  provider: 'openai',
  ApiKey: `encrypted:${SECRET}`,
  baseUrl: 'https://api.internal-provider.example/v1',
  promptTemplate: 'internal prompt template',
  temperature: '0.5',
  ...over,
} as unknown as Model);

const completionFixture = (over: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-real-123',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-test',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  ...over,
});

beforeEach(async () => {
  for (const k of Object.keys(store)) delete store[k];
  mockCreateCompletion.mockReset();
  (getCompletionAdapter as jest.Mock).mockClear();
  privateFixture = await installPrivateProfileFixture(metadata => { store['encryption_key'] = metadata; });
  jest.mocked(testModelConnection).mockClear();
});

describe('fallback policy lifecycle', () => {
  const policy = (): Model => ({ id: 'policy', name: 'policy/prod', ApiKey: '', fallbackPolicy: { modelIds: ['m1', 'm2'] } });
  beforeEach(() => { store[StorageKey.MODELS] = [modelFixture(), modelFixture({ id: 'm2', displayName: 'Backup' })]; });
  it('creates and updates a policy without a provider credential on the alias', async () => {
    expect((await modelService.addModel(policy())).success).toBe(true);
    expect((await modelService.updateModel({ ...policy(), displayName: 'Production' })).success).toBe(true);
    const saved = (store[StorageKey.MODELS] as Model[]).find(item => item.id === 'policy');
    expect(saved?.ApiKey).toBe('');
    expect(saved?.fallbackPolicy?.modelIds).toEqual(['m1', 'm2']);
  });
  it('rejects dangling references and prevents deletion of members', async () => {
    expect((await modelService.addModel({ ...policy(), fallbackPolicy: { modelIds: ['m1', 'missing'] } })).success).toBe(false);
    await modelService.addModel(policy());
    expect((await modelService.deleteModel('m1')).success).toBe(false);
    expect((await modelService.deleteModel('policy')).success).toBe(true);
    expect((await modelService.deleteModel('m1')).success).toBe(true);
  });
  it('resolves the policy alias independently of other display names and keeps the actual-model receipt', async () => {
    await modelService.addModel(policy());
    (store[StorageKey.MODELS] as Model[]).push(modelFixture({ id: 'collision', displayName: 'policy/prod' }));
    const routing = { policyId: 'policy', selectedModelId: 'm2', attempts: [] };
    mockCreateCompletion.mockResolvedValue({ completion: completionFixture({ model: 'actual-backup' }), routing });
    const result = await modelService.generateChatCompletion({ modelIdentifier: 'policy/prod', messages: [] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.completion).toMatchObject({ model: 'actual-backup', flujo_routing: routing });
    expect(mockCreateCompletion.mock.calls[0][0]).toMatchObject({ model: { id: 'policy' }, apiKey: '' });
  });
});

describe('/v1/models listing', () => {
  it('discovers policies using a stable alias with no credential fields', async () => {
    store[StorageKey.FLOWS] = [];
    store[StorageKey.MODELS] = [{ id: 'p', name: 'policy/prod', displayName: 'Production', ApiKey: '', fallbackPolicy: { modelIds: ['m1', 'm2'] } }];
    const response = await listModels();
    expect(await response.json()).toEqual({ object: 'list', data: [{ id: 'policy/prod', object: 'model' }] });
  });
  it('lists flow- and model- entries with only id/object (no secrets)', async () => {
    store[StorageKey.FLOWS] = [{ id: 'f1', name: 'MyFlow', nodes: [], edges: [] }];
    store[StorageKey.MODELS] = [modelFixture()];

    const res = await listModels();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.object).toBe('list');
    expect(body.data).toEqual([
      { id: 'flow-MyFlow', object: 'model' },
      { id: 'model-GPT Test', object: 'model' },
    ]);

    // Hard FLUJO rule: no model internals may ever be serialized to clients.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('encrypted:');
    expect(raw).not.toContain('internal-provider');
    expect(raw).not.toContain('prompt template');
  });

  it('falls back to the technical name and dedupes repeated ids', async () => {
    store[StorageKey.FLOWS] = [];
    store[StorageKey.MODELS] = [
      modelFixture({ id: 'm1', displayName: undefined }),
      modelFixture({ id: 'm2', displayName: undefined }), // same technical name → one entry
      modelFixture({ id: 'm3', displayName: 'Other' }),
    ];

    const res = await listModels();
    const body = await res.json();
    expect(body.data).toEqual([
      { id: 'model-gpt-test', object: 'model' },
      { id: 'model-Other', object: 'model' },
    ]);
  });

  it('degrades to flows-only when model storage fails', async () => {
    store[StorageKey.FLOWS] = [{ id: 'f1', name: 'MyFlow', nodes: [], edges: [] }];
    store.__throwOnLoad = StorageKey.MODELS;

    const res = await listModels();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ id: 'flow-MyFlow', object: 'model' }]);
  });
});

describe('ModelService.testModel — local CLI authentication', () => {
  it('tests a saved Antigravity CLI model with an empty key', async () => {
    store[StorageKey.MODELS] = [modelFixture({ name: 'flash', provider: 'antigravity-cli', adapter: 'antigravity-cli', ApiKey: '' })];
    await modelService.testModel({ modelId: 'm1' });
    expect(testModelConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', adapter: 'antigravity-cli', provider: 'antigravity-cli', modelName: 'flash' }));
  });

  it('tests an unsaved Antigravity CLI connection without requiring an API key', async () => {
    await modelService.testModel({ name: 'flash', adapter: 'antigravity-cli', provider: 'antigravity-cli' });
    expect(testModelConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', adapter: 'antigravity-cli' }));
  });

  it('resolves a provider-only Antigravity CLI diagnostic request to the local-auth adapter', async () => {
    await modelService.testModel({ name: 'flash', provider: 'antigravity-cli' });
    expect(testModelConnection).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: '', adapter: 'antigravity-cli', provider: 'antigravity-cli', modelName: 'flash',
    }));
  });

  it('tests a saved provider-only Antigravity CLI connection without requiring a key', async () => {
    store[StorageKey.MODELS] = [modelFixture({ name: 'flash', provider: 'antigravity-cli', adapter: undefined, ApiKey: '' })];
    await modelService.testModel({ modelId: 'm1' });
    expect(testModelConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', adapter: 'antigravity-cli' }));
  });

  it('does not substitute a saved key after an explicitly supplied draft binding fails', async () => {
    store[StorageKey.MODELS] = [modelFixture({ provider: 'antigravity-cli', adapter: 'antigravity-cli' })];
    jest.mocked(resolveAndDecryptApiKey).mockClear();
    jest.mocked(resolveAndDecryptApiKey).mockResolvedValueOnce(null);
    await expect(modelService.testModel({ modelId: 'm1', apiKey: '${env:MISSING_DRAFT_KEY}' }))
      .rejects.toThrow('Could not resolve an API key');
    expect(resolveAndDecryptApiKey).toHaveBeenCalledTimes(1);
    expect(resolveAndDecryptApiKey).toHaveBeenCalledWith('${env:MISSING_DRAFT_KEY}');
    expect(testModelConnection).not.toHaveBeenCalled();
  });

  it('uses local Google authentication when a saved connection key is explicitly cleared for testing', async () => {
    store[StorageKey.MODELS] = [modelFixture({ provider: 'antigravity-cli', adapter: 'antigravity-cli' })];
    await modelService.testModel({ modelId: 'm1', apiKey: '' });
    expect(testModelConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', adapter: 'antigravity-cli' }));
  });

  it('fails a key binding instead of switching the test to local Google authentication', async () => {
    store[StorageKey.MODELS] = [modelFixture({ provider: 'antigravity-cli', adapter: 'antigravity-cli', ApiKey: '${env:MISSING_KEY}' })];
    jest.mocked(resolveAndDecryptApiKey).mockResolvedValueOnce(null);
    await expect(modelService.testModel({ modelId: 'm1' })).rejects.toThrow('Could not resolve an API key');
    expect(testModelConnection).not.toHaveBeenCalled();
  });

  it('still rejects empty-key native Gemini diagnostic requests', async () => {
    await expect(modelService.testModel({ name: 'gemini-2.5-flash', provider: 'gemini', adapter: 'gemini' })).rejects.toThrow('Could not resolve an API key');
    expect(testModelConnection).not.toHaveBeenCalled();
  });
});

describe('ModelService.generateChatCompletion — resolution', () => {
  const messages = [{ role: 'user' as const, content: 'Hi' }];

  it('resolves by display name (case-insensitive) and calls the adapter with the decrypted key', async () => {
    store[StorageKey.MODELS] = [modelFixture()];
    mockCreateCompletion.mockResolvedValue({ completion: completionFixture() });

    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'gpt test'.toUpperCase(), // "GPT TEST" → matches "GPT Test"
      messages,
    });

    expect(result.success).toBe(true);
    expect(mockCreateCompletion).toHaveBeenCalledTimes(1);
    const input = mockCreateCompletion.mock.calls[0][0];
    expect(input.model.id).toBe('m1');
    expect(input.apiKey).toBe(SECRET); // decrypted, backend-only
    expect(input.messages).toEqual(messages);
    expect(input.temperature).toBe(0.5); // model default when the request has none
    expect(input.maxTurns).toBe(1); // single-turn semantics
  });

  it('falls back to the technical name when no display name matches', async () => {
    store[StorageKey.MODELS] = [modelFixture({ displayName: 'Something Else' })];
    mockCreateCompletion.mockResolvedValue({ completion: completionFixture() });

    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'gpt-test',
      messages,
      temperature: 0.9,
    });

    expect(result.success).toBe(true);
    expect(mockCreateCompletion.mock.calls[0][0].temperature).toBe(0.9); // request wins
  });

  it('returns 404 model_not_found for an unknown identifier', async () => {
    store[StorageKey.MODELS] = [modelFixture()];

    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'nope',
      messages,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(404);
      expect(result.error.code).toBe('model_not_found');
    }
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });

  it('returns 400 model_ambiguous when the technical name matches several models', async () => {
    store[StorageKey.MODELS] = [
      modelFixture({ id: 'm1', name: 'openrouter/auto', displayName: 'A' }),
      modelFixture({ id: 'm2', name: 'openrouter/auto', displayName: 'B' }),
    ];

    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'openrouter/auto',
      messages,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(400);
      expect(result.error.code).toBe('model_ambiguous');
    }
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });

  it('rejects client tools for the claude-cli adapter instead of silently diverging', async () => {
    store[StorageKey.MODELS] = [modelFixture({ adapter: 'claude-cli' } as Partial<Model>)];

    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'GPT Test',
      messages,
      tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(400);
      expect(result.error.code).toBe('tools_not_supported_for_this_model');
    }
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });

  it('runs an empty-key Antigravity CLI connection using local Google authentication', async () => {
    store[StorageKey.MODELS] = [modelFixture({ name: 'flash', provider: 'antigravity-cli', adapter: 'antigravity-cli', ApiKey: '' })];
    mockCreateCompletion.mockResolvedValue({ completion: completionFixture() });
    const result = await modelService.generateChatCompletion({ modelIdentifier: 'GPT Test', messages });
    expect(result.success).toBe(true);
    expect(mockCreateCompletion).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', model: expect.objectContaining({ adapter: 'antigravity-cli' }) }));
  });

  it('runs a provider-only Antigravity CLI connection with its default local-auth adapter', async () => {
    store[StorageKey.MODELS] = [modelFixture({ name: 'flash', provider: 'antigravity-cli', adapter: undefined, ApiKey: '' })];
    mockCreateCompletion.mockResolvedValue({ completion: completionFixture() });
    const result = await modelService.generateChatCompletion({ modelIdentifier: 'GPT Test', messages });
    expect(result.success).toBe(true);
    expect(mockCreateCompletion).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: '', model: expect.objectContaining({ provider: 'antigravity-cli' }),
    }));
  });

  it('rejects caller-owned tools for a provider-only Antigravity CLI connection before dispatch', async () => {
    store[StorageKey.MODELS] = [modelFixture({ provider: 'antigravity-cli', adapter: undefined })];
    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'GPT Test', messages,
      tools: [{ type: 'function', function: { name: 'outside', parameters: {} } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('tools_not_supported_for_this_model');
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });

  it('rejects caller-owned tools for Antigravity CLI, whose tool loop runs in FLUJO', async () => {
    store[StorageKey.MODELS] = [modelFixture({ provider: 'antigravity-cli', adapter: 'antigravity-cli', ApiKey: '' })];
    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'GPT Test', messages,
      tools: [{ type: 'function', function: { name: 'outside', parameters: {} } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('tools_not_supported_for_this_model');
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });

  it('does not switch a failed Antigravity CLI key binding to the local Google account', async () => {
    store[StorageKey.MODELS] = [modelFixture({ provider: 'antigravity-cli', adapter: 'antigravity-cli', ApiKey: '${env:MISSING_KEY}' })];
    jest.mocked(resolveAndDecryptApiKey).mockResolvedValueOnce(null);
    const result = await modelService.generateChatCompletion({ modelIdentifier: 'GPT Test', messages });
    expect(result.success).toBe(false);
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });

  it('still requires an API key for native Gemini', async () => {
    store[StorageKey.MODELS] = [modelFixture({ provider: 'gemini', adapter: 'gemini', ApiKey: '' })];
    const result = await modelService.generateChatCompletion({ modelIdentifier: 'GPT Test', messages });
    expect(result.success).toBe(false);
    expect(mockCreateCompletion).not.toHaveBeenCalled();
  });
});

describe('ModelService.generateChatCompletion — responses & errors', () => {
  const messages = [{ role: 'user' as const, content: 'Hi' }];

  beforeEach(() => {
    store[StorageKey.MODELS] = [modelFixture()];
  });

  it('returns the OpenAI-shaped completion with the public model- id', async () => {
    mockCreateCompletion.mockResolvedValue({ completion: completionFixture() });

    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'GPT Test',
      messages,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.completion.model).toBe('model-GPT Test');
      expect(result.completion.choices[0].message.content).toBe('Hello!');
      expect(result.completion.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

      // Nothing sensitive leaks through the serialized response.
      const raw = JSON.stringify(result.completion);
      expect(raw).not.toContain(SECRET);
      expect(raw).not.toContain('internal-provider');
    }
  });

  it('passes client tools through and returns tool_calls untouched', async () => {
    const toolCalls = [
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Bogota"}' } },
    ];
    mockCreateCompletion.mockResolvedValue({
      completion: completionFixture({
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
      }),
    });

    const tools = [{ type: 'function' as const, function: { name: 'get_weather', parameters: {} } }];
    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'GPT Test',
      messages,
      tools,
    });

    expect(mockCreateCompletion.mock.calls[0][0].tools).toEqual(tools);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.completion.choices[0].message.tool_calls).toEqual(toolCalls);
    }
  });

  it('sanitizes an in-band provider error (no raw payload echo)', async () => {
    mockCreateCompletion.mockResolvedValue({
      completion: {
        error: {
          message: 'Provider exploded',
          code: 'upstream_boom',
          type: 'provider_error_type',
          metadata: {
            provider_name: 'SomeUpstream',
            raw: JSON.stringify({ error: { message: 'quota exceeded' } }),
            echoed_request_headers: { authorization: `Bearer ${SECRET}` },
          },
        },
      },
    });

    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'GPT Test',
      messages,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(502);
      expect(result.error.code).toBe('upstream_boom');
      expect(result.error.message).toContain('Provider exploded');
      expect(result.error.message).toContain('SomeUpstream');
      expect(result.error.message).toContain('quota exceeded');
      // The raw provider body (which echoed the key) must NOT pass through.
      const raw = JSON.stringify(result);
      expect(raw).not.toContain(SECRET);
      expect(raw).not.toContain('echoed_request_headers');
    }
  });

  it('maps a thrown error to a 500 without leaking internals', async () => {
    mockCreateCompletion.mockRejectedValue(new Error('socket hang up'));

    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'GPT Test',
      messages,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(500);
      expect(result.error.code).toBe('internal_error');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it('rejects a completion without choices as an invalid provider response', async () => {
    mockCreateCompletion.mockResolvedValue({ completion: { id: 'x', choices: [] } });

    const result = await modelService.generateChatCompletion({
      modelIdentifier: 'GPT Test',
      messages,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(502);
      expect(result.error.code).toBe('invalid_provider_response');
    }
  });
});
