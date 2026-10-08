import assert from 'node:assert/strict';
import { test } from 'node:test';
import OpenAI from 'openai';
import { startFixtureServer } from './fixture-server.mjs';

const tool = (name, description = '', parameters = { type: 'object', properties: {} }) => ({
  type: 'function', function: { name, description, parameters },
});
const tools = [
  tool('call_behavior_receipt_123', 'Run the Persona Behavior "Journey receipt specialist" and return its Flow result.'),
  tool('Journey_receipt_App_journey_receipt'), tool('handoff_to_Finish'),
];

test('real SDK decodes streamed Behavior, App and Finish calls with actual tool results between them', async () => {
  const fixture = await startFixtureServer();
  try {
    const client = new OpenAI({ baseURL: `${fixture.url}/v1`, apiKey: 'fixture', maxRetries: 0 });
    const messages = [{ role: 'user', content: 'JOURNEY_CHAT' }];
    for (const [expected, result] of [
      ['call_behavior_receipt_123', 'JOURNEY-BEHAVIOR-RECEIPT:verified'],
      ['Journey_receipt_App_journey_receipt', 'JOURNEY-APP-RECEIPT:JOURNEY_CHAT'],
      ['handoff_to_Finish', 'done'],
    ]) {
      const stream = await client.chat.completions.create({ model: 'journey-model', messages, tools, stream: true, stream_options: { include_usage: true } });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const call = chunks[0].choices[0].delta.tool_calls[0];
      assert.equal(call.function.name, expected);
      assert.equal(chunks[1].choices[0].finish_reason, 'tool_calls');
      assert.equal(chunks[2].usage.total_tokens, 120);
      const { index: _index, ...assistantCall } = call;
      assert.equal(_index, 0);
      messages.push({ role: 'assistant', content: chunks[0].choices[0].delta.content, tool_calls: [assistantCall] },
        { role: 'tool', tool_call_id: call.id, content: result });
    }
    assert.equal(fixture.events.filter(event => event.kind === 'model_completion').length, 3);
  } finally { await fixture.close(); }
});

test('specialist result uses the nonstream SDK protocol, and unknown work fails closed', async () => {
  const fixture = await startFixtureServer();
  try {
    const client = new OpenAI({ baseURL: `${fixture.url}/v1`, apiKey: 'fixture', maxRetries: 0 });
    const result = await client.chat.completions.create({ model: 'journey-model', tools,
      messages: [{ role: 'system', content: 'JOURNEY_SPECIALIST_ONLY' }] });
    assert.equal(result.choices[0].message.content, 'JOURNEY-BEHAVIOR-RECEIPT:verified');
    assert.equal(result.choices[0].message.tool_calls[0].function.name, 'handoff_to_Finish');
    await assert.rejects(client.chat.completions.create({ model: 'journey-model', tools,
      messages: [{ role: 'user', content: 'Unrelated work' }] }), /only explicit/);
  } finally { await fixture.close(); }
});

test('held App work has no completed effect until the fixture releases it', async () => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const fixture = await startFixtureServer({ onEvent: event => { if (event.kind === 'app_started') started(); } });
  try {
    const pending = fetch(`${fixture.url}/receipt`, { method: 'POST', body: JSON.stringify({ token: 'JOURNEY_BUSY' }) });
    await waiting;
    assert.equal(fixture.events.filter(event => event.kind === 'app_completed').length, 0);
    fixture.releaseBusy();
    assert.deepEqual(await (await pending).json(), { receipt: 'JOURNEY-APP-RECEIPT:JOURNEY_BUSY' });
    assert.equal(fixture.events.filter(event => event.kind === 'app_completed').length, 1);
  } finally { await fixture.close(); }
});

test('the native outcome is required and must succeed before the Core finishes', async () => {
  const fixture = await startFixtureServer();
  try {
    const client = new OpenAI({ baseURL: `${fixture.url}/v1`, apiKey: 'fixture', maxRetries: 0 });
    const nativeTools = [...tools, tool('report_activity_outcome')];
    const messages = [{ role: 'user', content: 'JOURNEY_TASK' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'app', type: 'function', function: { name: 'Journey_receipt_App_journey_receipt', arguments: '{"token":"JOURNEY_TASK"}' } }] },
      { role: 'tool', tool_call_id: 'app', content: 'JOURNEY-APP-RECEIPT:JOURNEY_TASK' }];
    const completion = await client.chat.completions.create({ model: 'journey-model', tools: nativeTools, messages });
    const report = completion.choices[0].message;
    assert.equal(report.tool_calls[0].function.name, 'report_activity_outcome');
    assert.equal(JSON.parse(report.tool_calls[0].function.arguments).resolution, 'succeeded');
    messages.push(report, { role: 'tool', tool_call_id: report.tool_calls[0].id, content: 'Error: execution authority expired' });
    await assert.rejects(client.chat.completions.create({ model: 'journey-model', tools: nativeTools, messages }), /not accepted/);
    messages.at(-1).content = JSON.stringify({ reported: true, outcome: { resolution: 'succeeded',
      summary: 'JOURNEY_TASK: complete; verified JOURNEY-APP-RECEIPT:JOURNEY_TASK.' } });
    const finished = await client.chat.completions.create({ model: 'journey-model', tools: nativeTools, messages });
    assert.equal(finished.choices[0].message.tool_calls[0].function.name, 'handoff_to_Finish');
    assert.equal(finished.choices[0].message.content, 'JOURNEY_TASK: complete; verified JOURNEY-APP-RECEIPT:JOURNEY_TASK.');
  } finally { await fixture.close(); }
});
