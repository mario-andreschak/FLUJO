import { AntigravityCliEventDecoder, mapAntigravityCliUsage } from '@/backend/services/model/adapters/antigravityCliEvents';

test('decodes split/coalesced CRLF records and final unterminated result', () => {
  const events: unknown[] = [];
  const decoder = new AntigravityCliEventDecoder(event => events.push(event));
  decoder.push('{"event":"step_update","step_update":{"conversation_id":"id","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"he');
  decoder.push('llo"}}\r\n\n{"event":"result","result":{"conversation_id":"id","status":"SUCCESS","response":"hello"}}');
  decoder.finish();
  expect(events).toEqual([
    { event: 'step_update', step_update: { conversation_id: 'id', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'hello' } },
    { event: 'result', result: { conversation_id: 'id', status: 'SUCCESS', response: 'hello' } },
  ]);
});

test.each(['not json\n', '{"event":"new-event"}\n', '{"event":"step_update","step_update":{"text_delta":9}}\n', '{"event":"result","result":{"status":"pending"}}\n'])('rejects invalid output without echoing it: %s', line => {
  const decoder = new AntigravityCliEventDecoder(() => {});
  expect(() => decoder.push(line)).toThrow(/Antigravity CLI returned/);
});

test('bounds records and includes cached input without double counting thinking', () => {
  const decoder = new AntigravityCliEventDecoder(() => {}, 20);
  expect(() => decoder.push('x'.repeat(21))).toThrow(/exceeded/);
  expect(mapAntigravityCliUsage({ input_tokens: 100, output_tokens: 20, thinking_tokens: 15, total_tokens: 120, cache_read_tokens: 70 })).toEqual({
    prompt_tokens: 170, completion_tokens: 20, total_tokens: 190,
    prompt_tokens_details: { cached_tokens: 70 }, completion_tokens_details: { reasoning_tokens: 15 },
  });
  expect(mapAntigravityCliUsage({ input_tokens: -1, output_tokens: NaN, thinking_tokens: 9, cache_read_tokens: -900 }).total_tokens).toBe(0);
});
