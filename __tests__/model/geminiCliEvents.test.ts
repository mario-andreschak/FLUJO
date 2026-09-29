import { GeminiCliEventDecoder, mapGeminiCliUsage } from '@/backend/services/model/adapters/geminiCliEvents';

test('decodes split/coalesced CRLF records and the final unterminated record', () => {
  const events: unknown[] = [];
  const decoder = new GeminiCliEventDecoder(event => events.push(event));
  decoder.push('{"type":"message","role":"assistant","content":"he');
  decoder.push('llo","delta":true}\r\n\n{"type":"error","severity":"warning","message":"retry"}\n{"type":"result","status":"success"}');
  decoder.finish();
  expect(events).toEqual([
    { type: 'message', role: 'assistant', content: 'hello', delta: true },
    { type: 'error', severity: 'warning', message: 'retry' },
    { type: 'result', status: 'success' },
  ]);
});

test.each(['not json\n', '{"type":"new-event"}\n', '{"type":"message","role":"assistant","content":9}\n', '{"type":"result","status":"pending"}\n'])('rejects invalid structured output without echoing it: %s', line => {
  const decoder = new GeminiCliEventDecoder(() => {});
  expect(() => decoder.push(line)).toThrow(/Gemini CLI returned/);
});

test('bounds records even without a newline and maps cached usage without double counting', () => {
  const decoder = new GeminiCliEventDecoder(() => {}, 20);
  expect(() => decoder.push('x'.repeat(21))).toThrow(/exceeded/);
  expect(mapGeminiCliUsage({ input_tokens: 100, output_tokens: 20, total_tokens: 125, cached: 70 })).toEqual({
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 125, prompt_tokens_details: { cached_tokens: 70 },
  });
  expect(mapGeminiCliUsage({ input_tokens: -1, output_tokens: NaN, cached: 900 }).total_tokens).toBe(0);
});
