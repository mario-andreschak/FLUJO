import type OpenAI from 'openai';
import {
  CODEX_EMERGENCY_COMPACTION_MARKER,
  estimateCodexInputCharacters,
  refitCodexMessagesForInputLimit,
} from '@/backend/services/model/adapters/codexInputCompaction';

describe('Codex input hard-limit preflight', () => {
  it('leaves a request below the configured target unchanged', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ];
    const result = refitCodexMessagesForInputLimit(messages, { targetCharacters: 8_192 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.sourceMessageIndexes).toEqual([0, 1]);
  });

  it('omits oldest assistant/tool traffic and injects an explicit marker', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'original task' },
      ...Array.from({ length: 10 }, (_, index): OpenAI.ChatCompletionMessageParam => (
        index % 2 === 0
          ? { role: 'assistant', content: `old assistant ${index} ${'a'.repeat(2_500)}` }
          : { role: 'tool', tool_call_id: `call-${index}`, content: `old tool ${index} ${'t'.repeat(2_500)}` }
      )),
      { role: 'user', content: 'latest task' },
      { role: 'assistant', content: 'recent answer' },
    ];
    const result = refitCodexMessagesForInputLimit(messages, {
      targetCharacters: 8_192,
      keepRecentMessages: 2,
    });

    expect(result.compacted).toBe(true);
    expect(result.omitted.assistant + result.omitted.tool).toBeGreaterThan(0);
    expect(result.messages.some(message => (
      typeof message.content === 'string' && message.content.startsWith(CODEX_EMERGENCY_COMPACTION_MARKER)
    ))).toBe(true);
    expect(result.messages.some(message => message.content === 'latest task')).toBe(true);
    expect(result.finalCharacters).toBeLessThanOrEqual(8_192);
    expect(result.sourceMessageIndexes).toHaveLength(result.messages.length);
  });

  it('bounds pathological retained system and user text', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 's'.repeat(30_000) },
      { role: 'user', content: 'u'.repeat(30_000) },
    ];
    const result = refitCodexMessagesForInputLimit(messages, { targetCharacters: 8_192 });
    expect(estimateCodexInputCharacters(result.messages)).toBeLessThanOrEqual(8_192);
    expect(JSON.stringify(result.messages)).toContain('FLUJO truncated');
  });
});
