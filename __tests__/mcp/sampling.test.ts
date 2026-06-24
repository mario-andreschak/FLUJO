/**
 * Tests for MCP sampling (#15): the design-time trust policy that lets a server ask FLUJO
 * to run an LLM call (server -> client). Verifies the request is converted to OpenAI
 * messages, routed through the completion-adapter seam using the pinned model, the result
 * is shaped back to CreateMessageResult, and the rolling rate limit fires.
 */

const getModelMock = jest.fn();
const resolveKeyMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...a: unknown[]) => getModelMock(...a),
    resolveAndDecryptApiKey: (...a: unknown[]) => resolveKeyMock(...a),
  },
}));

const createCompletionMock = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: (...a: unknown[]) => createCompletionMock(...a) }),
}));

import { samplingEnabled, samplingConfigKey, registerSamplingHandler } from '@/backend/services/mcp/sampling';

const cfg = (sampling?: unknown) => ({ name: 'srv', transport: 'stdio', sampling }) as any;

// Capture the handler registered on a fake client, so we can invoke it directly.
function captureHandler(config: any) {
  let handler: (req: any) => Promise<any> = async () => ({});
  const fakeClient = { setRequestHandler: (_schema: unknown, h: any) => { handler = h; } } as any;
  registerSamplingHandler(fakeClient, config);
  return handler;
}

const sampleRequest = {
  params: {
    systemPrompt: 'You are helpful.',
    temperature: 0.3,
    messages: [
      { role: 'user', content: { type: 'text', text: 'Hello' } },
      { role: 'assistant', content: { type: 'image', data: '...', mimeType: 'image/png' } },
    ],
  },
};

beforeEach(() => {
  getModelMock.mockReset().mockResolvedValue({ name: 'gpt-4o', ApiKey: 'enc', adapter: 'openai' });
  resolveKeyMock.mockReset().mockResolvedValue('sk-key');
  createCompletionMock
    .mockReset()
    .mockResolvedValue({ completion: { choices: [{ message: { content: 'Hi there' } }] } });
});

describe('samplingEnabled / samplingConfigKey', () => {
  it('is enabled only when explicitly on AND a model is pinned', () => {
    expect(samplingEnabled(cfg({ enabled: true, modelId: 'm1' }))).toBe(true);
    expect(samplingEnabled(cfg({ enabled: true }))).toBe(false); // no model
    expect(samplingEnabled(cfg({ enabled: false, modelId: 'm1' }))).toBe(false);
    expect(samplingEnabled(cfg(undefined))).toBe(false);
  });

  it('key is empty when disabled and changes with the policy', () => {
    expect(samplingConfigKey(cfg({ enabled: false, modelId: 'm1' }))).toBe('');
    expect(samplingConfigKey(cfg({ enabled: true, modelId: 'm1' }))).not.toBe(
      samplingConfigKey(cfg({ enabled: true, modelId: 'm2' }))
    );
  });
});

describe('sampling handler', () => {
  it('converts the request, routes through the adapter, and returns a CreateMessageResult', async () => {
    const handler = captureHandler(cfg({ enabled: true, modelId: 'm1' }));
    const result = await handler(sampleRequest);

    expect(result).toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'Hi there' },
      model: 'gpt-4o',
      stopReason: 'endTurn',
    });

    const passed = createCompletionMock.mock.calls[0][0];
    expect(passed.temperature).toBe(0.3);
    expect(passed.apiKey).toBe('sk-key');
    // systemPrompt -> system message; text content preserved; non-text replaced with a note.
    expect(passed.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(passed.messages[1]).toEqual({ role: 'user', content: 'Hello' });
    expect(passed.messages[2].content).toContain('unsupported');
  });

  it('rejects when sampling is not enabled', async () => {
    const handler = captureHandler(cfg({ enabled: false, modelId: 'm1' }));
    await expect(handler(sampleRequest)).rejects.toThrow(/not enabled/i);
  });

  it('enforces the rolling rate limit', async () => {
    const handler = captureHandler(cfg({ enabled: true, modelId: 'm1', maxCallsPerMinute: 2 }));
    await handler(sampleRequest);
    await handler(sampleRequest);
    await expect(handler(sampleRequest)).rejects.toThrow(/rate limit/i);
    expect(createCompletionMock).toHaveBeenCalledTimes(2); // the 3rd never reached the model
  });
});
