import type OpenAI from 'openai';
import type { RunResourceEntry } from '@/shared/types/runResources';
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
      { role: 'tool', tool_call_id: 'call-old', content: 'x'.repeat(12_000) + '\nflujo://run/conv/receipt' },
      { role: 'assistant', content: 'old prose '.repeat(300) },
      { role: 'user', content: 'latest task' },
      { role: 'assistant', content: 'recent answer' },
    ];
    const result = emergencyRefitMessages(messages, {
      target: 2_000,
      measure,
      keepRecentMessages: 2,
      resourceMarkers: new Map([['call-old', { result: { uri: 'flujo://run/conv/receipt',
        producedBy: { toolCallId: 'call-old' } } as RunResourceEntry }]]),
    });

    expect(result.compacted).toBe(true);
    expect(result.after).toBeLessThanOrEqual(2_000);
    expect(result.omittedMessageIndexes).toEqual(expect.arrayContaining([2, 3]));
    expect(result.messages.some(message => (
      typeof message.content === 'string' && message.content.startsWith(EMERGENCY_CONTEXT_REFIT_MARKER)
    ))).toBe(true);
    expect(result.messages.some(message => message.content === 'latest task')).toBe(true);
    expect(result.sourceMessageIndexes).toHaveLength(result.messages.length);
    expect(result.messages.some(message => typeof message.content === 'string'
      && message.content.includes('"call_id":"call-old"'))).toBe(true);
    expect(JSON.stringify(result.messages)).toContain('flujo://run/conv/receipt');

    const remainingToolIds = new Set(result.messages
      .filter(message => message.role === 'assistant')
      .flatMap(message => message.role === 'assistant' ? (message.tool_calls ?? []).map(call => call.id) : []));
    for (const message of result.messages) {
      if (message.role === 'tool') expect(remainingToolIds.has(message.tool_call_id)).toBe(true);
    }
  });

  it('refuses infeasible protected instructions without changing or truncating them', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'z'.repeat(20_000) },
    ];
    const result = emergencyRefitMessages(messages, { target: 1_500, measure });
    expect(result.capacityExceeded).toBe(true);
    expect(result.messages).toEqual(messages);
    expect(result.truncatedMessageIndexes).toEqual([]);
  });

  it('retains old Spanish corrections and developer instructions verbatim', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'developer', content: 'Never publish without approval.' },
      { role: 'user', content: 'No envíes correo. Corrijo: el ID exacto es pedido-ñ-002.' },
      ...Array.from({ length: 8 }, () => ({ role: 'assistant' as const, content: 'old prose '.repeat(900) })),
      { role: 'user', content: 'Continúa.' },
    ];
    const result = emergencyRefitMessages(messages, { target: 2_000, measure, keepRecentMessages: 2 });
    expect(result.messages).toEqual(expect.arrayContaining([messages[0], messages[1], messages.at(-1)]));
    expect(result.omitted.user).toBe(0);
  });

  it('keeps unresolved or unarchived tool groups when capacity is exceeded', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'Do not send twice.' },
      { role: 'assistant', content: null,
        tool_calls: [{ id: 'send-exact-1', type: 'function', function: { name: 'send', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'send-exact-1', content: 'unarchived receipt '.repeat(2_000) },
      { role: 'user', content: 'Continue.' },
      { role: 'assistant', content: 'Recent.' },
    ];
    const result = emergencyRefitMessages(messages, { target: 2_000, measure, keepRecentMessages: 2 });
    expect(result.capacityExceeded).toBe(true);
    expect(result.messages).toEqual(messages);
    const pending = emergencyRefitMessages([messages[0], messages[1], messages[3], messages[4]],
      { target: 1, measure, keepRecentMessages: 2 });
    expect(pending.messages).toContain(messages[1]);
    expect(pending.omittedMessageIndexes).not.toContain(1);
  });

  it('does not mistake an arbitrary tool-output URI for an archive of that call', () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'assistant', content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'send', arguments: '{"id":"pedido-ñ-002"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'unarchived '.repeat(2_000) + 'flujo://run/conv/unrelated' },
      { role: 'user', content: 'Continue.' }, { role: 'user', content: 'Next.' },
    ];
    const result = emergencyRefitMessages(messages, { target: 2_000, measure, keepRecentMessages: 2 });
    expect(result.capacityExceeded).toBe(true);
    expect(result.messages).toEqual(messages);
    const wrong = emergencyRefitMessages(messages, { target: 2_000, measure, keepRecentMessages: 2,
      resourceMarkers: new Map([['call-1', { result: { uri: 'flujo://run/conv/unrelated',
        producedBy: { toolCallId: 'another-call' } } as RunResourceEntry }]]) });
    expect(wrong.capacityExceeded).toBe(true);
    expect(wrong.messages).toEqual(messages);
  });
});
