import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import {
  isOfficialOpenAiEndpoint,
  prepareOpenAiPromptCacheWire,
  stripOpenAiPromptCacheBreakpoints,
  supportsExplicitOpenAiPromptCaching,
} from '@/backend/services/model/adapters/openaiPromptCaching';

const BASE_URLS: Partial<Record<NonNullable<Model['provider']>, string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  litellm: 'http://localhost:4000/v1',
  martllm: 'https://api.martllm.com/v1',
};

const model = (
  name: string,
  provider: Model['provider'] = 'openai',
  baseUrl = BASE_URLS[provider!],
): Pick<Model, 'name' | 'provider' | 'adapter' | 'baseUrl'> => ({ name, provider, baseUrl });

const breakpointOf = (message: OpenAI.ChatCompletionMessageParam) => {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  return (content.at(-1) as { prompt_cache_breakpoint?: unknown } | undefined)
    ?.prompt_cache_breakpoint;
};

describe('OpenAI GPT-5.6 explicit prompt-cache wire', () => {
  it('is restricted to official OpenAI GPT-5.6 and later model families', () => {
    expect(supportsExplicitOpenAiPromptCaching(model('gpt-5.6'))).toBe(true);
    expect(supportsExplicitOpenAiPromptCaching(model('gpt-5.6-mini'))).toBe(true);
    expect(supportsExplicitOpenAiPromptCaching(model('gpt-6'))).toBe(true);
    expect(supportsExplicitOpenAiPromptCaching({ ...model('openai/gpt-5.6', 'litellm'), adapter: 'openai' })).toBe(true);
    expect(supportsExplicitOpenAiPromptCaching({ ...model('flujo/gateway', 'litellm'), adapter: 'openai' })).toBe(false);
    expect(supportsExplicitOpenAiPromptCaching(model('gpt-5.5'))).toBe(false);
    expect(supportsExplicitOpenAiPromptCaching(model('gpt-5.6', 'openrouter'))).toBe(false);
    expect(supportsExplicitOpenAiPromptCaching({
      ...model('gpt-5.6'),
      adapter: 'openai-responses',
    })).toBe(true);
  });

  it('moves the node instruction after history and marks the latest four reusable boundaries', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'node-specific instructions' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ];
    const prepared = prepareOpenAiPromptCacheWire(messages, model('gpt-5.6'), {
      lateNodeInstruction: true,
    });

    expect(prepared.explicit).toBe(true);
    expect(prepared.breakpointCount).toBe(4);
    expect(prepared.messages.map(message => message.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'system',
    ]);
    expect(breakpointOf(prepared.messages[0])).toBeUndefined();
    for (const message of prepared.messages.slice(1, 5)) {
      expect(breakpointOf(message)).toEqual({ mode: 'explicit' });
    }
    expect(prepared.messages.at(-1)).toMatchObject({
      role: 'system',
      content: 'node-specific instructions',
    });
  });

  it('keeps the previous terminal breakpoint in a normally growing conversation', () => {
    const prior = prepareOpenAiPromptCacheWire([
      { role: 'system', content: 'node A' },
      { role: 'user', content: 'task' },
    ], model('gpt-5.6'), { lateNodeInstruction: true });
    const next = prepareOpenAiPromptCacheWire([
      { role: 'system', content: 'node B' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'working' },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ], model('gpt-5.6'), { lateNodeInstruction: true });

    expect(breakpointOf(prior.messages[0])).toEqual({ mode: 'explicit' });
    expect(breakpointOf(next.messages[0])).toEqual({ mode: 'explicit' });
    expect(next.messages.at(-1)).toMatchObject({ role: 'system', content: 'node B' });
  });

  it('moves older official OpenAI wires without sending unsupported controls', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'task' },
    ];
    const prepared = prepareOpenAiPromptCacheWire(messages, model('gpt-5.5'), {
      lateNodeInstruction: true,
    });
    expect(prepared.messages.map(message => message.role)).toEqual(['user', 'system']);
    expect(prepared.explicit).toBe(false);
    expect(prepared.breakpointCount).toBe(0);
    expect(prepared.lateSystem).toBe(true);
  });

  it('leaves non-node calls and compatible gateways byte-identical', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'task' },
    ];
    expect(prepareOpenAiPromptCacheWire(messages, model('gpt-5.6'), {
      lateNodeInstruction: false,
    }).messages).toBe(messages);
    expect(prepareOpenAiPromptCacheWire(messages, model('gpt-5.6', 'openrouter'), {
      lateNodeInstruction: true,
    }).messages).toBe(messages);
  });

  it('keeps the system message first for MartLLM, even for an OpenAI model behind it', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'task' },
    ];
    const martllm = { ...model('openai/gpt-5.6', 'martllm'), adapter: 'openai' as const };
    expect(supportsExplicitOpenAiPromptCaching(martllm)).toBe(false);
    const prepared = prepareOpenAiPromptCacheWire(messages, martllm, { lateNodeInstruction: true });
    expect(prepared.messages).toBe(messages);
    expect(prepared.lateSystem).toBe(false);
  });

  it('removes markers for the adapter compatibility retry', () => {
    const prepared = prepareOpenAiPromptCacheWire([
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'task' },
    ], model('gpt-5.6'), { lateNodeInstruction: true });
    const stripped = stripOpenAiPromptCacheBreakpoints(prepared.messages);
    expect(breakpointOf(stripped[0])).toBeUndefined();
    expect(stripped.at(-1)).toMatchObject({ role: 'system', content: 'instructions' });
  });
});

describe('which servers get the OpenAI cache order (issue #1367)', () => {
  const VLLM = 'http://10.0.0.5:8000/v1';
  const conversation: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You are a worker.' },
    { role: 'user', content: 'task' },
  ];

  it('decides from the server address, not the provider name', () => {
    expect(isOfficialOpenAiEndpoint('https://api.openai.com/v1')).toBe(true);
    expect(isOfficialOpenAiEndpoint('https://us.api.openai.com/v1')).toBe(true);
    expect(isOfficialOpenAiEndpoint(undefined)).toBe(true);
    expect(isOfficialOpenAiEndpoint('')).toBe(true);
    expect(isOfficialOpenAiEndpoint(VLLM)).toBe(false);
    expect(isOfficialOpenAiEndpoint('https://api.openai.com.example.net/v1')).toBe(false);
    expect(isOfficialOpenAiEndpoint('not a url')).toBe(false);
  });

  it('keeps the system message first for a self-hosted server saved as "openai"', () => {
    const qwen = model('Qwen/Qwen3-32B', 'openai', VLLM);
    const prepared = prepareOpenAiPromptCacheWire(conversation, qwen, { lateNodeInstruction: true });
    expect(prepared.messages).toBe(conversation);
    expect(prepared.lateSystem).toBe(false);
    expect(supportsExplicitOpenAiPromptCaching(model('gpt-5.6', 'openai', VLLM))).toBe(false);
    expect(prepareOpenAiPromptCacheWire(conversation, { ...qwen, adapter: 'openai-responses' }, {
      lateNodeInstruction: true,
    }).messages).toBe(conversation);
  });

  it('lets Azure OpenAI move it only for GPT models', () => {
    const azure = 'https://flujo-test.openai.azure.com/openai/v1';
    expect(prepareOpenAiPromptCacheWire(conversation, model('gpt-5.6', 'openai', azure), {
      lateNodeInstruction: true,
    }).messages.map(message => message.role)).toEqual(['user', 'system']);
    expect(prepareOpenAiPromptCacheWire(conversation, model('DeepSeek-R1', 'openai', azure), {
      lateNodeInstruction: true,
    }).messages).toBe(conversation);
  });

  it('follows OPENAI_BASE_URL when the model has no address of its own', () => {
    const saved = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = VLLM;
    try {
      expect(isOfficialOpenAiEndpoint(undefined)).toBe(false);
      expect(isOfficialOpenAiEndpoint('https://api.openai.com/v1')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = saved;
    }
  });
});
