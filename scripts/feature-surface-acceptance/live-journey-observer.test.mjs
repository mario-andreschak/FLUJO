import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedJson, collectLiveEvents, digest, evaluateLiveJourney, loopbackOrigin, projectEvent, projectModelInput } from './live-journey-observer.mjs';

// Synthetic classifier/parser controls only. These are never installed/provider/human receipts.
const context = { conversationId: 'conversation', flowId: 'flow', modelId: 'owner-model', toolName: 'app__fixture_tool_128', fixtureToolName: 'fixture_tool_128' };
const args = { element: 'synthetic', ref: 'marker', enabled: false };
const producerBinding = text => ({ serialization: 'utf8-string-v1', sha256: digest(text), bytes: Buffer.byteLength(text) });
const resultText = 'synthetic echo';
const event = (seq, type, rest = {}) => ({ seq, type, timestamp: seq, conversationId: context.conversationId, ...rest });
function sample() {
  const raw = [event(0, 'run:start', { flowId: 'flow' }),
    event(1, 'model:dispatch', { turn: { id: 'first', conversationId: 'conversation', modelId: 'owner-model', adapter: 'test' } }),
    event(2, 'model:dispatch-result', { dispatchId: 'first', outcome: 'completed' }),
    event(3, 'run:awaiting_approval', { pendingToolCalls: [{ id: 'call' }] }),
    event(4, 'run:paused', { reason: 'debug', phase: 'before-tool' }),
    event(5, 'tool:call', { toolCallId: 'call', name: context.toolName, args: JSON.stringify(args) }),
    event(6, 'tool:result', { toolCallId: 'call', name: context.toolName, result: resultText,
      resultContentBinding: producerBinding(resultText), isError: false }),
    event(7, 'model:dispatch', { turn: { id: 'second', conversationId: 'conversation', modelId: 'owner-model', adapter: 'test' } }),
    event(8, 'model:dispatch-result', { dispatchId: 'second', outcome: 'completed' }),
    event(9, 'message', { message: { id: 'answer', role: 'assistant', content: 'synthetic answer' } }),
    event(10, 'run:done', { status: 'completed' })];
  return { ...context, events: raw.map(row => projectEvent(row, 'conversation')),
    modelInputs: [projectModelInput({ entry: { id: 'second', conversationId: 'conversation', modelId: 'owner-model', adapter: 'test' },
      genericWire: [{ role: 'tool', tool_call_id: 'call', content: resultText }] }, 'conversation', 'second')],
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
  ['same call ID with wrong archived content', value => { value.modelInputs[0].wireToolResults[0].contentBinding = producerBinding('unrelated synthetic content'); }],
  ['same digest with wrong archived byte count', value => { value.modelInputs[0].wireToolResults[0].contentBinding.bytes += 1; }],
  ['missing full runtime content binding', value => { delete value.events.find(row => row.type === 'tool:result').resultContentBinding; }],
  ['missing archive content binding', value => { delete value.modelInputs[0].wireToolResults[0].contentBinding; }],
  ['unknown content serialization', value => { value.modelInputs[0].wireToolResults[0].contentBinding.serialization = 'json-normalized'; }],
]) test(`rejects ${name}`, () => { const value = sample(); mutate(value); assert.equal(evaluateLiveJourney(value).componentPassed, false); });
test('duplicate archive results for one call remain ambiguous even with a matching copy', () => {
  const value = sample(); value.modelInputs[0].wireToolResults.push({ toolCallId: 'call', contentBinding: producerBinding('wrong') });
  assert.equal(evaluateLiveJourney(value).componentPassed, false);
});
test('duplicate runtime results for one call remain ambiguous', () => {
  const value = sample(); value.events.splice(7, 0, { ...value.events[6] });
  value.events.forEach((row, index) => { row.seq = index; });
  assert.equal(evaluateLiveJourney(value).componentPassed, false);
});
function longResultSample(text, wireText = text) {
  const value = sample();
  value.events[6] = projectEvent(event(6, 'tool:result', { toolCallId: 'call', name: context.toolName,
    result: `${text.slice(0, 500)}…`, resultContentBinding: { ...producerBinding(text), privateExtra: 'private value' }, isError: false }), 'conversation');
  value.modelInputs[0] = projectModelInput({ entry: { id: 'second', conversationId: 'conversation', modelId: 'owner-model', adapter: 'test' },
    genericWire: [{ role: 'tool', tool_call_id: 'call', content: wireText }] }, 'conversation', 'second');
  return value;
}
test('full UTF-8 result binding matches archived content despite a truncated event preview', () => {
  const text = JSON.stringify({ text: 'café🙂'.repeat(150), ending: 'correct' });
  const value = longResultSample(text); const result = evaluateLiveJourney(value);
  assert.equal(result.componentPassed, true); assert.equal(result.fullFeatureAcceptance, false);
  assert.equal(result.gradeAwarded, false);
  assert(value.events[6].resultContentBinding.bytes > text.length);
  assert.notEqual(value.events[6].resultSha256, value.modelInputs[0].wireToolResults[0].contentBinding.sha256);
  assert(!JSON.stringify(value).includes('private value')); assert(!JSON.stringify(value).includes('correct'));
});
test('equal event previews cannot hide different full archived tails', () => {
  const prefix = 'café🙂'.repeat(150); const actual = prefix + 'correct'; const wrong = prefix + 'wrong';
  assert.equal(actual.slice(0, 500), wrong.slice(0, 500));
  assert.equal(evaluateLiveJourney(longResultSample(actual, wrong)).componentPassed, false);
});
test('JSON-equivalent content with different serialization is not an exact binding', () => {
  const value = sample();
  value.events[6] = projectEvent(event(6, 'tool:result', { toolCallId: 'call', name: context.toolName,
    result: '{"ok":true}', resultContentBinding: producerBinding('{"ok":true}'), isError: false }), 'conversation');
  value.modelInputs[0].wireToolResults[0].contentBinding = producerBinding('{ "ok": true }');
  assert.equal(evaluateLiveJourney(value).componentPassed, false);
});
test('text arrays are not silently treated as runtime string content', () => {
  const value = sample();
  value.modelInputs[0] = projectModelInput({ entry: { id: 'second', conversationId: 'conversation', modelId: 'owner-model', adapter: 'test' },
    genericWire: [{ role: 'tool', tool_call_id: 'call', content: [{ type: 'text', text: resultText }] }] }, 'conversation', 'second');
  assert.equal(value.modelInputs[0].wireToolResults[0].unsupportedContentRepresentation, true);
  assert.equal(evaluateLiveJourney(value).componentPassed, false);
});
test('one correctly bound call cannot hide another call with wrong content', () => {
  const value = sample();
  value.events.splice(7, 0, { ...value.events[5], toolCallId: 'second-call' }, { ...value.events[6], toolCallId: 'second-call' });
  value.events.forEach((row, index) => { row.seq = index; });
  value.fixtureAfter.toolCalls = 2; value.fixtureAfter.acceptedCalls = 2;
  value.fixtureAfter.recentCalls.push({ ...value.fixtureAfter.recentCalls[0], sequence: 2 });
  value.modelInputs[0].wireToolResults.push({ toolCallId: 'second-call', contentBinding: producerBinding('unrelated') });
  const result = evaluateLiveJourney(value);
  assert.equal(result.checks.allExpectedCallsCorrelated, true);
  assert.equal(result.checks.toolResultInLaterModelInput, false); assert.equal(result.componentPassed, false);
});
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
