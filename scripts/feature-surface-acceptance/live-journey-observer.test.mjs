import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedJson, collectLiveEvents, createProjectionBudget, digest, evaluateLiveJourney, loopbackOrigin,
  projectConversationStatus, projectEvent, projectFixtureReceipt, projectFixtureToolPage, projectModelInput,
  serializeEvidenceReport } from './live-journey-observer.mjs';

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
  const prefix = 'café🙂'.repeat(150); const actual = prefix + 'correct'; const wrong = prefix + 'wrong!!';
  assert.equal(actual.slice(0, 500), wrong.slice(0, 500));
  assert.equal(Buffer.byteLength(actual), Buffer.byteLength(wrong));
  assert.notEqual(producerBinding(actual).sha256, producerBinding(wrong).sha256);
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
  assert.throws(() => projectEvent(event(1, 'tool:call', { toolCallId: 'call', name: 'tool', args: '{unfinished' }), 'conversation'), SyntaxError);
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
  await assert.rejects(collectLiveEvents(responseFor(frame(event(1, 'run:start', { flowId: 'flow' })) + frame(event(0, 'run:done', { status: 'completed' }))), 'conversation'), /repeated or reordered/);
  await assert.rejects(collectLiveEvents(responseFor(frame(event(0, 'run:start', { flowId: 'flow' }))), 'conversation'), /ended before a terminal/);
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

const privateMarker = 'SYNTHETIC_PRIVATE_METADATA_NOT_A_CREDENTIAL';
const nestedMarker = () => ({ unexpectedPrivateMetadata: privateMarker });
const fixtureDefinition = 'a'.repeat(64);
function fixtureReceipt() {
  return { runId: '648c705c-348d-4a4f-b81c-97b6d9b65d74', fixtureVersion: '1.0.0', definitionSha256: fixtureDefinition,
    mode: 'normal', delayMs: 0, listRequests: 4, toolCalls: 1, acceptedCalls: 1,
    recentCalls: [{ sequence: 1, toolName: 'fixture_tool_128', argumentsSha256: digest(JSON.stringify(args)), accepted: true }] };
}
test('fixture receipt projection omits unexpected fields before report retention', () => {
  const input = fixtureReceipt(); const expected = structuredClone(input);
  input.privateMetadata = nestedMarker(); input.recentCalls[0].privateMetadata = nestedMarker();
  const report = { fixtureBefore: projectFixtureReceipt(input, fixtureDefinition) };
  assert.deepEqual(report.fixtureBefore, expected);
  assert(!serializeEvidenceReport(report).includes(privateMarker));
  assert(JSON.stringify(input).includes(privateMarker));
});
test('invalid fixture receipts never enter partial failure reports', () => {
  for (const [name, mutate] of [
    ['nested run identity', value => { value.runId = nestedMarker(); }],
    ['unexpected definition', value => { value.definitionSha256 = 'b'.repeat(64); }],
    ['nested mode', value => { value.mode = nestedMarker(); }],
    ['nested counter', value => { value.toolCalls = nestedMarker(); }],
    ['impossible accepted count', value => { value.acceptedCalls = 2; }],
    ['nested call metadata', value => { value.recentCalls[0].argumentsSha256 = nestedMarker(); }],
    ['noncontiguous call', value => { value.recentCalls[0].sequence = 2; }],
    ['unexpected fixture version', value => { value.fixtureVersion = '2.0.0'; }],
  ]) {
    for (const field of ['fixtureBefore', 'fixtureAfter']) {
      const report = { status: 'incomplete', ...(field === 'fixtureAfter'
        ? { fixtureBefore: projectFixtureReceipt(fixtureReceipt(), fixtureDefinition) } : {}) };
      const input = fixtureReceipt(); mutate(input); input.privateMetadata = nestedMarker();
      assert.throws(() => { report[field] = projectFixtureReceipt(input, fixtureDefinition); }, undefined, `${name}/${field}`);
      assert(!Object.hasOwn(report, field)); assert(!serializeEvidenceReport(report).includes(privateMarker));
      if (field === 'fixtureAfter') assert.deepEqual(report.fixtureBefore, fixtureReceipt());
    }
  }
});
test('fixture receipt projection accepts a genuine-shaped capped invocation window', () => {
  const input = fixtureReceipt(); input.toolCalls = 65; input.acceptedCalls = 65;
  input.recentCalls = Array.from({ length: 64 }, (_, index) => ({ ...input.recentCalls[0], sequence: index + 2 }));
  assert.deepEqual(projectFixtureReceipt(input, fixtureDefinition), input);
  input.recentCalls.push({ ...input.recentCalls.at(-1), sequence: 66 });
  assert.throws(() => projectFixtureReceipt(input, fixtureDefinition));
});
test('event metadata rejects nested values before retention', () => {
  const cases = [
    event(0, 'run:start', { flowId: nestedMarker() }),
    event(0, 'run:done', { status: nestedMarker() }),
    event(0, 'run:done', { status: 'completed', depth: nestedMarker() }),
    event(0, 'run:paused', { reason: nestedMarker(), phase: 'before-tool' }),
    event(0, 'run:paused', { reason: 'debug', phase: nestedMarker() }),
    event(0, 'run:awaiting_approval', { pendingToolCalls: [{ id: nestedMarker() }] }),
    event(0, 'model:dispatch', { turn: { id: 'dispatch', conversationId: 'conversation', modelId: nestedMarker(), adapter: 'test' } }),
    event(0, 'model:dispatch', { turn: { id: 'dispatch', conversationId: 'conversation', modelId: 'model', adapter: nestedMarker() } }),
    event(0, 'model:dispatch-result', { dispatchId: nestedMarker(), outcome: 'completed' }),
    event(0, 'model:dispatch-result', { dispatchId: 'dispatch', outcome: nestedMarker() }),
    event(0, 'tool:call', { toolCallId: nestedMarker(), name: 'tool', args: '{}' }),
    event(0, 'tool:result', { toolCallId: 'call', name: nestedMarker(), result: 'synthetic' }),
    event(0, 'message', { message: { id: nestedMarker(), role: 'assistant', content: 'synthetic' } }),
    event(0, 'message', { message: { id: 'message', role: nestedMarker(), content: 'synthetic' } }),
  ];
  for (const input of cases) assert.throws(() => projectEvent(input, 'conversation'), undefined, input.type);
});
test('SSE refuses the preserved nested pause marker before its output callback', async () => {
  const input = event(0, 'run:paused', { reason: nestedMarker(), phase: nestedMarker() });
  const retained = [];
  await assert.rejects(collectLiveEvents(responseFor(`data: ${JSON.stringify(input)}\n\n`), 'conversation',
    { onEvent: row => retained.push(row) }));
  assert.deepEqual(retained, []); assert(!JSON.stringify(retained).includes(privateMarker));
});
test('event admission rejects oversize identities and unsupported typed metadata', () => {
  assert.throws(() => projectEvent(event(0, 'model:dispatch-result', { dispatchId: 'x'.repeat(257), outcome: 'completed' }), 'conversation'));
  assert.throws(() => projectEvent(event(0, privateMarker), 'conversation'));
  assert.throws(() => projectEvent(event(0, 'run:paused', { reason: 'debug', phase: 'unsupported' }), 'conversation'));
  assert.throws(() => projectEvent(event(0, 'message', { message: { role: 'assistant', content: 'text', tool_calls: nestedMarker() } }), 'conversation'));
  assert.equal(projectEvent(event(0, 'run:paused', { reason: 'breakpoint' }), 'conversation').phase, undefined);
});
test('archive metadata rejects the preserved nested marker before report retention', () => {
  const initial = { entry: { id: 'dispatch', conversationId: 'conversation', modelId: 'model', adapter: 'test' },
    genericWire: [{ role: 'tool', tool_call_id: 'call', content: 'synthetic' }] };
  for (const mutate of [value => { value.entry.modelId = nestedMarker(); }, value => { value.entry.adapter = nestedMarker(); },
    value => { value.genericWire[0].tool_call_id = nestedMarker(); }]) {
    const snapshot = structuredClone(initial); mutate(snapshot); const retained = [];
    assert.throws(() => retained.push(projectModelInput(snapshot, 'conversation', 'dispatch')));
    assert.deepEqual(retained, []); assert(!JSON.stringify(retained).includes(privateMarker));
  }
  const healthy = projectModelInput(initial, 'conversation', 'dispatch');
  assert.equal(healthy.wireToolResults[0].contentBinding.sha256, digest('synthetic'));
});
test('final conversation status rejects nested metadata and preserves ordinary status', () => {
  assert.throws(() => projectConversationStatus(nestedMarker()));
  assert.equal(projectConversationStatus('completed'), 'completed');
  assert.equal(projectConversationStatus(undefined), undefined);
  assert.equal(projectConversationStatus('awaiting_tool_approval'), 'awaiting_tool_approval');
  assert.throws(() => projectConversationStatus('unsupported'));
});
test('aggregate projection budget refuses accumulation before append', () => {
  const first = { dispatchId: 'one', text: 'café🙂' }; const second = { dispatchId: 'two', text: 'café🙂' };
  const bytes = Buffer.byteLength(JSON.stringify(first, null, 2)); const budget = createProjectionBudget(bytes);
  const retained = []; retained.push(budget.admit(first));
  assert.equal(budget.usedBytes(), bytes);
  assert.throws(() => retained.push(budget.admit(second))); assert.deepEqual(retained, [first]);
  assert.equal(budget.usedBytes(), bytes);
});
test('evidence report output budget counts final UTF-8 serialization', () => {
  const report = { status: 'incomplete', text: 'café🙂' };
  const expected = JSON.stringify(report, null, 2) + '\n'; const bytes = Buffer.byteLength(expected);
  assert.equal(serializeEvidenceReport(report, bytes), expected);
  assert.throws(() => serializeEvidenceReport(report, bytes - 1));
});
test('fixture discovery admits only exact expected ordered names', () => {
  const page = { tools: Array.from({ length: 32 }, (_, index) => ({ name: `fixture_tool_${String(index + 1).padStart(3, '0')}`,
    privateMetadata: nestedMarker() })), nextCursor: '32', privateMetadata: nestedMarker() };
  const projected = projectFixtureToolPage(page, 0);
  assert.equal(projected.tools.length, 32); assert.equal(projected.nextCursor, '32');
  assert.equal(projected.tools[0], 'fixture_tool_001'); assert(!JSON.stringify(projected).includes(privateMarker));
  assert.deepEqual(projectFixtureToolPage({ tools: [{ name: 'fixture_tool_128' }] }, 127).tools, ['fixture_tool_128']);
});
test('fixture discovery refuses extra or private metadata before accumulation', () => {
  const retained = [];
  for (const page of [
    { tools: Array.from({ length: 129 }, (_, index) => ({ name: `fixture_tool_${String(index + 1).padStart(3, '0')}` })) },
    { tools: [{ name: nestedMarker() }] },
    { tools: [{ name: 'fixture_tool_001' }], nextCursor: nestedMarker() },
    { tools: [{ name: 'fixture_tool_001' }], nextCursor: 'x'.repeat(257) },
  ]) assert.throws(() => retained.push(...projectFixtureToolPage(page, 0).tools));
  assert.deepEqual(retained, []);
});
