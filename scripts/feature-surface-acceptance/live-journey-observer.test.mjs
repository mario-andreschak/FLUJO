import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedJson, collectLiveEvents, digest, evaluateLiveJourney, loopbackOrigin, projectEvent, projectModelInput } from './live-journey-observer.mjs';

// Synthetic classifier/parser controls only. These are never installed/provider/human receipts.
const context = { conversationId: 'conversation', flowId: 'flow', modelId: 'owner-model', toolName: 'app__fixture_tool_128', fixtureToolName: 'fixture_tool_128' };
const args = { element: 'synthetic', ref: 'marker', enabled: false };
const event = (seq, type, rest = {}) => ({ seq, type, timestamp: seq, conversationId: context.conversationId, ...rest });
function sample() {
  const raw = [event(0, 'run:start', { flowId: 'flow' }),
    event(1, 'model:dispatch', { turn: { id: 'first', conversationId: 'conversation', modelId: 'owner-model', adapter: 'test' } }),
    event(2, 'model:dispatch-result', { dispatchId: 'first', outcome: 'completed' }),
    event(3, 'run:awaiting_approval', { pendingToolCalls: [{ id: 'call' }] }),
    event(4, 'run:paused', { reason: 'debug', phase: 'before-tool' }),
    event(5, 'tool:call', { toolCallId: 'call', name: context.toolName, args: JSON.stringify(args) }),
    event(6, 'tool:result', { toolCallId: 'call', name: context.toolName, result: 'synthetic echo', isError: false }),
    event(7, 'model:dispatch', { turn: { id: 'second', conversationId: 'conversation', modelId: 'owner-model', adapter: 'test' } }),
    event(8, 'model:dispatch-result', { dispatchId: 'second', outcome: 'completed' }),
    event(9, 'message', { message: { id: 'answer', role: 'assistant', content: 'synthetic answer' } }),
    event(10, 'run:done', { status: 'completed' })];
  return { ...context, events: raw.map(row => projectEvent(row, 'conversation')),
    modelInputs: [{ dispatchId: 'second', modelId: 'owner-model', adapter: 'test', wireToolResults: [{ toolCallId: 'call', contentSha256: digest('echo') }] }],
    fixtureBefore: { runId: 'fixture', definitionSha256: 'definition', toolCalls: 0, acceptedCalls: 0 },
    fixtureAfter: { runId: 'fixture', definitionSha256: 'definition', toolCalls: 1, acceptedCalls: 1,
      recentCalls: [{ sequence: 1, toolName: 'fixture_tool_128', argumentsSha256: digest(JSON.stringify(args)), accepted: true }] } };
}
test('complete synthetic correlations pass only the component, never full acceptance', () => {
  const result = evaluateLiveJourney(sample()); assert.equal(result.componentPassed, true);
  assert.equal(result.fullFeatureAcceptance, false); assert.equal(result.gradeAwarded, false);
});
for (const [name, mutate] of [
  ['saved model without actual dispatch', value => { value.events = value.events.filter(row => !row.type.startsWith('model:')); }],
  ['tool result absent from later model input', value => { value.modelInputs[0].wireToolResults = []; }],
  ['failed later dispatch', value => { value.events.find(row => row.dispatchId === 'second' && row.type === 'model:dispatch-result').outcome = 'error'; }],
  ['result ID mismatch', value => { value.events.find(row => row.type === 'tool:result').toolCallId = 'unrelated'; }],
  ['fixture from another run', value => { value.fixtureAfter.runId = 'other'; }],
  ['discovery-only zero-call receipt', value => { value.fixtureAfter.toolCalls = 0; value.fixtureAfter.recentCalls = []; }],
  ['mismatched arguments', value => { value.fixtureAfter.recentCalls[0].argumentsSha256 = digest('other'); }],
  ['approval for another call', value => { value.events.find(row => row.type === 'run:awaiting_approval').pendingToolCallIds = ['other']; }],
  ['missing debugger observation', value => { value.events = value.events.filter(row => row.type !== 'run:paused'); }],
  ['capped completion', value => { value.events.at(-1).status = 'capped'; }],
  ['another flow', value => { value.events[0].flowId = 'other'; }],
  ['archive from another adapter', value => { value.modelInputs[0].adapter = 'other'; }],
  ['noncontiguous fixture sequence', value => { value.fixtureAfter.recentCalls[0].sequence = 4; }],
]) test(`rejects ${name}`, () => { const value = sample(); mutate(value); assert.equal(evaluateLiveJourney(value).componentPassed, false); });
test('one fixture receipt cannot satisfy two equal runtime calls', () => {
  const value = sample(); value.events.splice(6, 0, { ...value.events[5], toolCallId: 'second-call' });
  value.events.forEach((row, index) => { row.seq = index; });
  value.fixtureAfter.toolCalls = 2; value.fixtureAfter.acceptedCalls = 2;
  value.fixtureAfter.recentCalls.push({ ...value.fixtureAfter.recentCalls[0], sequence: 2, argumentsSha256: digest('unmatched') });
  assert.equal(evaluateLiveJourney(value).checks.allExpectedCallsCorrelated, false);
});
test('archive projection removes raw tool results and rejects another conversation', () => {
  const snapshot = { entry: { id: 'second', conversationId: 'conversation', modelId: 'owner-model', adapter: 'test' },
    genericWire: [{ role: 'tool', tool_call_id: 'call', content: 'private tool content' }], sdkRequest: { secret: 'private credential' } };
  const result = projectModelInput(snapshot, 'conversation', 'second');
  assert(!JSON.stringify(result).includes('private')); assert.throws(() => projectModelInput(snapshot, 'other', 'second'));
});
test('message and argument projections retain hashes without plaintext', () => {
  const message = projectEvent(event(0, 'message', { message: { role: 'assistant', content: 'private output' } }), 'conversation');
  assert.equal(message.textBytes, 14); assert(!JSON.stringify(message).includes('private output'));
  assert.throws(() => projectEvent(event(1, 'tool:call', { args: '{unfinished' }), 'conversation'));
});
test('loopback origin excludes URL credentials, paths and remote hosts', () => {
  assert.equal(loopbackOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const url of ['http://user:pass@127.0.0.1:3000', 'http://127.0.0.1:3000/private', 'https://example.com', 'http://localhost:3000']) assert.throws(() => loopbackOrigin(url));
});
function responseFor(text) {
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.subarray(offset, offset + 3));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('SSE handles split UTF-8/CRLF frames, comments and an inner terminal event', async () => {
  const raw = [event(0, 'message', { message: { role: 'assistant', content: 'café' } }),
    event(1, 'run:done', { depth: 1, status: 'completed' }), event(2, 'run:done', { status: 'completed' })];
  const rows = await collectLiveEvents(responseFor(': connected\r\n\r\n' + raw.map(row => 'data: ' + JSON.stringify(row) + '\r\n\r\n').join('')), 'conversation');
  assert.equal(rows.length, 3); assert.equal(rows[0].textBytes, 5);
});
test('SSE rejects reordered sequences and truncated runs', async () => {
  const frame = row => 'data: ' + JSON.stringify(row) + '\n\n';
  await assert.rejects(collectLiveEvents(responseFor(frame(event(1, 'run:start')) + frame(event(0, 'run:done', { status: 'completed' }))), 'conversation'));
  await assert.rejects(collectLiveEvents(responseFor(frame(event(0, 'run:start'))), 'conversation'));
});
test('bounded JSON counts UTF-8 bytes and rejects overflow', async () => {
  const raw = JSON.stringify({ text: 'café' }); const bytes = Buffer.byteLength(raw);
  assert.deepEqual(await boundedJson(new Response(raw), bytes), { text: 'café' });
  await assert.rejects(boundedJson(new Response(raw), bytes - 1));
});
test('SSE refuses excessive bytes and another conversation', async () => {
  const frame = 'data: ' + JSON.stringify(event(0, 'run:done', { status: 'completed' })) + '\n\n';
  await assert.rejects(collectLiveEvents(responseFor(frame), 'conversation', { maximumBytes: 4 }));
  await assert.rejects(collectLiveEvents(responseFor(frame), 'other'));
});
