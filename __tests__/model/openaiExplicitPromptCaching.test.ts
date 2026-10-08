import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import {
  prepareOpenAiPromptCacheWire,
  stripOpenAiPromptCacheBreakpoints,
  supportsExplicitOpenAiPromptCaching,
} from '@/backend/services/model/adapters/openaiPromptCaching';

const model = (
  name: string,
  provider: Model['provider'] = 'openai',
): Pick<Model, 'name' | 'provider' | 'adapter'> => ({ name, provider });

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
    expect(supportsExplicitOpenAiPromptCaching(model('gpt-5.5'))).toBe(false);
    expect(supportsExplicitOpenAiPromptCaching(model('gpt-5.6', 'openrouter'))).toBe(false);
    expect(supportsExplicitOpenAiPromptCaching({
      ...model('gpt-5.6'),
      adapter: 'openai-responses',
    })).toBe(false);
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
