import OpenAI from 'openai';
import { normalizeMessageInput } from '@/backend/services/model/adapters/messageNormalization';

const asMessages = (messages: unknown[]): OpenAI.ChatCompletionMessageParam[] =>
  messages as OpenAI.ChatCompletionMessageParam[];

describe('provider-neutral message normalization', () => {
  it('hoists system text and preserves the text-only fast path', () => {
    expect(
      normalizeMessageInput([
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ]),
    ).toEqual({ systemPrompt: 'Be concise.', text: 'Hello', images: [] });
  });

  it('returns ordered text and neutral image metadata for multimodal input', () => {
    const normalized = normalizeMessageInput(
      asMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YWJj' } },
            { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
          ],
        },
      ]),
    );

    expect(normalized.text).toBe('Inspect this');
    expect(normalized.images).toEqual([
      { url: 'data:image/jpeg;base64,YWJj', mimeType: 'image/jpeg', base64: 'YWJj' },
      { url: 'https://example.com/image.png' },
    ]);
  });

  it('skips malformed, missing-url, and unsupported multipart entries', () => {
    const normalized = normalizeMessageInput(
      asMessages([
        { role: 'user', content: null },
        {
          role: 'user',
          content: [
            null,
            { type: 'image_url', image_url: {} },
            { type: 'file', file: { id: 'unsupported' } },
            { type: 'text', text: 'kept' },
          ],
        },
      ]),
    );

    expect(normalized).toEqual({ systemPrompt: undefined, text: 'kept', images: [] });
  });

  it('renders tool calls and results inside the inert history envelope', () => {
    const normalized = normalizeMessageInput(
      asMessages([
        { role: 'user', content: 'Find it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' },
      ]),
    );

    expect(normalized.text).toContain('<conversation_history>');
    expect(normalized.text).toContain('[prior action] lookup (call_id: call_1)\narguments: {"q":"x"}');
    expect(normalized.text).toContain('[prior action result] lookup (call_id: call_1)\nfound');
  });

  it('retains developer instructions and exact unarchived tool payloads/identifiers', () => {
    const instruction = 'No publicar sin aprobación. '.repeat(300);
    const argumentsText = JSON.stringify({ path: 'C:/pedido-ñ-002', content: 'A'.repeat(8_000) });
    const resultText = 'receipt-ñ-002 ' + 'R'.repeat(12_000);
    const input = normalizeMessageInput([
      { role: 'developer', content: instruction },
      { role: 'assistant', content: null, tool_calls: [{ id: 'send-once-002', type: 'function',
        function: { name: 'send', arguments: argumentsText } }] },
      { role: 'tool', tool_call_id: 'send-once-002', content: resultText },
    ]);
    expect(input.systemPrompt).toContain(instruction);
    expect(input.systemPrompt).toContain('<developer_instructions>');
    expect(input.text).toContain(argumentsText);
    expect(input.text).toContain(resultText);
    expect(input.text.match(/call_id: send-once-002/g)).toHaveLength(2);
    expect(input.text).not.toContain('[truncated');
  });
});
