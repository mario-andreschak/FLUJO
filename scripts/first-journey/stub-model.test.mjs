import assert from 'node:assert/strict';
import test from 'node:test';
import { STUB_FINAL_PREFIX, STUB_MODEL_ID, STUB_TEST_REPLY, planCompletion, startStubModel } from './stub-model.mjs';

const tool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });

test('answers a plain test prompt with the fixed reply', () => {
  assert.deepEqual(planCompletion({ messages: [{ role: 'user', content: 'Say hello' }] }), { role: 'assistant', content: STUB_TEST_REPLY });
});

test('calls the tool the user names, even when it carries a server prefix', () => {
  const plan = planCompletion({
    messages: [{ role: 'user', content: 'Please use list_directory now' }],
    tools: [tool('filesystem__read_file'), tool('filesystem__list_directory')],
  });
  assert.equal(plan.tool_calls[0].function.name, 'filesystem__list_directory');
  assert.equal(plan.tool_calls[0].function.arguments, '{}');
});

test('falls back to the preferred harmless tool, and answers with the tool result afterwards', () => {
  const tools = [tool('bash__run'), tool('filesystem__list_allowed_directories')];
  const first = planCompletion({ messages: [{ role: 'user', content: 'Which folders can you see?' }], tools });
  assert.equal(first.tool_calls[0].function.name, 'filesystem__list_allowed_directories');
  const second = planCompletion({
    tools,
    messages: [
      { role: 'user', content: 'Which folders can you see?' },
      first,
      { role: 'tool', tool_call_id: first.tool_calls[0].id, content: [{ type: 'text', text: 'Allowed directories:\nC:\\data' }] },
    ],
  });
  assert.equal(second.content, `${STUB_FINAL_PREFIX} Allowed directories: C:\\data`);
});

test('passes the AI Setup tool round-trip check by calling its diagnostic tool and returning the receipt', () => {
  const tools = [tool('flujo-model-test__verify_tool_round_trip')];
  const prompt = 'Run the provided FLUJO diagnostic tool exactly once with requestId "abc-123" and payload {"values":[2,3]}.';
  const first = planCompletion({ tools, messages: [{ role: 'user', content: prompt }] });
  assert.deepEqual(JSON.parse(first.tool_calls[0].function.arguments), { requestId: 'abc-123', payload: { values: [2, 3] } });
  const second = planCompletion({
    tools,
    messages: [
      { role: 'user', content: prompt },
      first,
      { role: 'tool', tool_call_id: first.tool_calls[0].id, content: '{"content":[{"type":"text","text":"{\\"sum\\":5,\\"receipt\\":\\"flujo-tool-1\\"}"}]}' },
    ],
  });
  assert.match(second.content, /flujo-tool-1/);
});

test('a tool result from an earlier question does not end the next one', () => {
  const tools = [tool('filesystem__list_allowed_directories')];
  const plan = planCompletion({
    tools,
    messages: [
      { role: 'user', content: 'first' },
      { role: 'tool', tool_call_id: 'x', content: 'old' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'again please' },
    ],
  });
  assert.ok(plan.tool_calls, 'expected a new tool call for the new question');
});

test('serves the model list and streamed and plain completions over loopback', async () => {
  const stub = await startStubModel();
  try {
    assert.match(stub.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const models = await (await fetch(`${stub.url}/models`)).json();
    assert.equal(models.data[0].id, STUB_MODEL_ID);

    const plain = await (await fetch(`${stub.url}/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: STUB_MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }),
    })).json();
    assert.equal(plain.choices[0].message.content, STUB_TEST_REPLY);

    const streamed = await (await fetch(`${stub.url}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: STUB_MODEL_ID, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }], tools: [tool('list_allowed_directories')] }),
    })).text();
    const chunks = streamed.split('\n\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
    assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, 'list_allowed_directories');
    assert.equal(chunks[1].choices[0].finish_reason, 'tool_calls');
    assert.ok(chunks.at(-1).usage);
    assert.ok(streamed.trimEnd().endsWith('data: [DONE]'));
    assert.deepEqual(stub.events.map((event) => event.kind), ['completion', 'completion']);

    const missing = await fetch(`${stub.url}/embeddings`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404);
  } finally {
    await stub.close();
  }
});
