import type OpenAI from 'openai';
import {
  emergencyRefitMessages,
  EMERGENCY_CONTEXT_REFIT_MARKER,
} from '@/backend/execution/flow/handlers/emergencyContextRefit';

const measure = (messages: readonly OpenAI.ChatCompletionMessageParam[]) => JSON.stringify(messages).length;

describe('provider-neutral emergency context refit', () => {
  it('removes old tool calls and results as complete structural groups', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old request' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-old', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-old', content: 'x'.repeat(12_000) },
      { role: 'assistant', content: 'old prose '.repeat(300) },
      { role: 'user', content: 'latest task' },
      { role: 'assistant', content: 'recent answer' },
    ];
    const result = emergencyRefitMessages(messages, {
      target: 2_000,
      measure,
      keepRecentMessages: 2,
    });

    expect(result.compacted).toBe(true);
    expect(result.after).toBeLessThanOrEqual(2_000);
    expect(result.omittedMessageIndexes).toEqual(expect.arrayContaining([2, 3]));
    expect(result.messages.some(message => (
      typeof message.content === 'string' && message.content.startsWith(EMERGENCY_CONTEXT_REFIT_MARKER)
    ))).toBe(true);
    expect(result.messages.some(message => message.content === 'latest task')).toBe(true);
    expect(result.sourceMessageIndexes).toHaveLength(result.messages.length);

    const remainingToolIds = new Set(result.messages
      .filter(message => message.role === 'assistant')
      .flatMap(message => message.role === 'assistant' ? (message.tool_calls ?? []).map(call => call.id) : []));
    for (const message of result.messages) {
      if (message.role === 'tool') expect(remainingToolIds.has(message.tool_call_id)).toBe(true);
    }
  });

  it('bounds a pathological current user message with an inline marker', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'z'.repeat(20_000) },
    ];
    const result = emergencyRefitMessages(messages, { target: 1_500, measure });
    expect(result.after).toBeLessThanOrEqual(1_500);
    expect(JSON.stringify(result.messages)).toContain('FLUJO truncated');
  });
});
