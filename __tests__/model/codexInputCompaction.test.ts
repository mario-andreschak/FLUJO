import type OpenAI from 'openai';
import type { RunResourceEntry } from '@/shared/types/runResources';
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
          ? { role: 'assistant', content: `old assistant ${index} ${'a'.repeat(2_500)}`,
            tool_calls: [{ id: `call-${index + 1}`, type: 'function', function: { name: 'read', arguments: '{}' } }] }
          : { role: 'tool', tool_call_id: `call-${index}`, content: `old tool ${index} ${'t'.repeat(2_500)}\nflujo://run/conv/receipt-${index}` }
      )),
      { role: 'user', content: 'latest task' },
      { role: 'assistant', content: 'recent answer' },
    ];
    const result = refitCodexMessagesForInputLimit(messages, {
      targetCharacters: 8_192,
      keepRecentMessages: 2,
      resourceMarkers: new Map([1, 3, 5, 7, 9].map(index => [`call-${index}`, {
        result: { uri: `flujo://run/conv/receipt-${index}`, producedBy: { toolCallId: `call-${index}` } } as RunResourceEntry,
      }])),
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

  it('refuses pathological retained system and user text without weakening their contract', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 's'.repeat(30_000) },
      { role: 'user', content: 'u'.repeat(30_000) },
    ];
    const result = refitCodexMessagesForInputLimit(messages, { targetCharacters: 8_192 });
    expect(result.capacityExceeded).toBe(true);
    expect(result.messages).toEqual(messages);
    expect(result.truncatedMessageIndexes).toEqual([]);
    expect(estimateCodexInputCharacters(result.messages)).toBeGreaterThan(8_192);
  });

  it('counts astral Unicode as code points rather than UTF-16 storage units', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: '😀'.repeat(8_000) }];
    const result = refitCodexMessagesForInputLimit(messages, { targetCharacters: 8_192 });
    expect(result.capacityExceeded).toBe(false);
    expect(result.messages).toEqual(messages);
  });
});
