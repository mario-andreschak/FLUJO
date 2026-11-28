/**
 * Issue #1367: what FLUJO sends to Chat Completions servers that run the
 * model's own chat template (vLLM, llama.cpp, LM Studio, Ollama), and how a
 * reply whose tokens reached the limit is read. The end-to-end check against
 * a stand-in for each server is `__tests__/flow/selfHostedStandInRuns.test.ts`.
 */
import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import { chatTemplateWireFor, toChatTemplateWire } from '@/backend/services/model/adapters/chatTemplateWire';
import { withLengthFromUsage } from '@/backend/services/model/adapters/cutOffReply';

type Message = OpenAI.ChatCompletionMessageParam;
const system = (content: string): Message => ({ role: 'system', content });
const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });

describe('toChatTemplateWire', () => {
  it('leaves a request with one leading system message and a user turn as it is', () => {
    const messages = [system('Rules'), user('Hi'), assistant('Hello'), user('Again')];
    expect(toChatTemplateWire(messages)).toBe(messages);
  });

  it('joins the system messages before the conversation into one', () => {
    expect(toChatTemplateWire([system('Node rules'), system('Summary rules'), user('Hi')]))
      .toEqual([system('Node rules\n\nSummary rules'), user('Hi')]);
  });

  it('keeps every text part, and any marker on it, when a system message has parts', () => {
    const marked = { type: 'text' as const, text: 'Stable', cache_control: { type: 'ephemeral' } };
    expect(toChatTemplateWire([{ role: 'system', content: [marked] }, system('Volatile'), user('Hi')])).toEqual([
      { role: 'system', content: [marked, { type: 'text', text: 'Volatile' }] },
      user('Hi'),
    ]);
  });

  it('sends a later system message as a user message in the same place', () => {
    // The compacted wire: a boundary note right before the current request.
    expect(toChatTemplateWire([system('Rules'), assistant('Summary'), system('Boundary'), user('Request')]))
      .toEqual([system('Rules'), assistant('Summary'), user('Boundary'), user('Request')]);
  });

  it('gives a compaction summary request a user turn', () => {
    expect(toChatTemplateWire([system('Summarize'), assistant('[transcript]'), system('Control and request')]))
      .toEqual([system('Summarize'), assistant('[transcript]'), user('Control and request')]);
  });

  it('sends the instructions as the user turn when a run starts without input', () => {
    expect(toChatTemplateWire([system('Do the task')])).toEqual([user('Do the task')]);
  });

  it('treats a developer message like a system message', () => {
    expect(toChatTemplateWire([{ role: 'developer', content: 'Rules' }, user('Hi')])).toEqual([system('Rules'), user('Hi')]);
  });
});

describe('chatTemplateWireFor', () => {
  const late = [user('Hi'), assistant('Hello'), system('Node rules')];
  const model = (baseUrl?: string, provider: Model['provider'] = 'openai'): Pick<Model, 'provider' | 'adapter' | 'name' | 'baseUrl'> =>
    ({ provider, adapter: 'openai', name: 'gpt-5.6', baseUrl });

  it('sends OpenAI\'s own servers the messages as written, including a late system message', () => {
    expect(chatTemplateWireFor(model(), late)).toBe(late);
    expect(chatTemplateWireFor(model('https://api.openai.com/v1'), late)).toBe(late);
  });

  it('puts the messages in template order for every other server, whatever the provider is called', () => {
    expect(chatTemplateWireFor(model('http://gpu-box:8000/v1'), late)).toEqual([user('Hi'), assistant('Hello'), user('Node rules')]);
    expect(chatTemplateWireFor(model('http://localhost:11434/v1', 'ollama'), [system('a'), system('b'), user('Hi')]))
      .toEqual([system('a\n\nb'), user('Hi')]);
  });
});

describe('withLengthFromUsage', () => {
  const reply = (finish: 'stop' | 'tool_calls' | 'length', usage?: OpenAI.CompletionUsage): OpenAI.Chat.Completions.ChatCompletion => ({
    id: 'r', object: 'chat.completion', created: 1, model: 'Qwen/Qwen3.5-35B-A3B',
    choices: [{ index: 0, finish_reason: finish, logprobs: null, message: { role: 'assistant', content: null, refusal: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash__run', arguments: '{"command": "rm -rf /tmp/rep"}' } }] } }],
    ...(usage ? { usage } : {}),
  });
  const usage = (prompt: number, completion: number) => ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion });

  it('reads a reply that used every allowed output token as cut off', () => {
    expect(withLengthFromUsage(reply('tool_calls', usage(900, 64)), { maxTokens: 64 }).choices[0].finish_reason).toBe('length');
  });

  it('reads a reply that filled the context window exactly, with no cap sent, as cut off', () => {
    expect(withLengthFromUsage(reply('tool_calls', usage(900, 31_868)), { contextWindow: 32_768 }).choices[0].finish_reason).toBe('length');
  });

  it('keeps the server\'s finish reason below the limit, without counts, or when it already says length', () => {
    const below = reply('tool_calls', usage(900, 63));
    expect(withLengthFromUsage(below, { maxTokens: 64, contextWindow: 32_768 })).toBe(below);
    const uncounted = reply('tool_calls');
    expect(withLengthFromUsage(uncounted, { maxTokens: 64 })).toBe(uncounted);
    const length = reply('length', usage(900, 64));
    expect(withLengthFromUsage(length, { maxTokens: 64 })).toBe(length);
  });

  it('does not guess from the context window when FLUJO sent a cap of its own', () => {
    const capped = reply('stop', usage(32_000, 768));
    expect(withLengthFromUsage(capped, { maxTokens: 4_000, contextWindow: 32_768 })).toBe(capped);
  });
});
