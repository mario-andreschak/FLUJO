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
    expect(normalized.text).toContain('[prior action] lookup\narguments: {"q":"x"}');
    expect(normalized.text).toContain('[prior action result] lookup\nfound');
  });
});
