import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCompactionTaskLeak, assertCompleteCanonicalFallback, assertSingleCompletedProviderCall, parseProviderResponse } from './compaction-source-task-check.mjs';

test('preserves a failed SSE terminal envelope and its provider error', () => {
  const error = { code: 'server_error', message: 'Service temporarily overloaded' };
  const raw = 'data: ' + JSON.stringify({ type: 'response.created', response: { id: 'retry', status: 'in_progress' } })
    + '\n\ndata: ' + JSON.stringify({ type: 'response.failed', response: { id: 'retry', status: 'failed', error } }) + '\n\ndata: [DONE]\n';
  const parsed = parseProviderResponse(raw);
  assert.equal(parsed.status, 'failed');
  assert.deepEqual(parsed.error, error);
  assert(parsed.eventTypes.includes('response.failed'));
});

test('preserves completed and incomplete SSE envelopes as different outcomes', () => {
  for (const status of ['completed', 'incomplete']) {
    const response = { id: 'terminal', status, output: [] };
    const parsed = parseProviderResponse('data: ' + JSON.stringify({ type: 'response.' + status, response }));
    assert.equal(parsed.status, status);
    assert.deepEqual(parsed.output, []);
  }
});

test('does not manufacture a completed response from partial SSE text', () => {
  const response = parseProviderResponse('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }));
  assert.equal(response.status, 'unresolved');
  assert.throws(() => assertSingleCompletedProviderCall([{ kind: 'summary', status: 200, response }], 'summary'));
});

test('retains a JSON provider error envelope without rewriting it', () => {
  const response = { error: { code: 'server_error' } };
  assert.deepEqual(parseProviderResponse(JSON.stringify(response)), response);
  const calls = [{ kind: 'summary', status: 200, response }, completedSummary()];
  assert.equal(assertSingleCompletedProviderCall(calls, 'summary'), calls[1]);
});

test('accepts a captured legacy failed SSE event trace before the successful retry', () => {
  const calls = [{ kind: 'summary', status: 200, response: { eventTypes: ['response.created', 'response.in_progress', 'response.failed'], content: '' } }, completedSummary()];
  assert.equal(assertSingleCompletedProviderCall(calls, 'summary'), calls[1]);
});

test('rejects a legacy stream containing a completed event without the completed envelope', () => {
  const calls = [{ kind: 'summary', status: 200, response: { eventTypes: ['response.failed', 'response.completed'] } }, completedSummary()];
  assert.throws(() => assertSingleCompletedProviderCall(calls, 'summary'));
});

const completedSummary = () => ({ kind: 'summary', status: 200, response: { status: 'completed' } });

test('accepts one completed summary without changing recorded attempts', () => {
  const calls = [completedSummary()];
  assert.equal(assertSingleCompletedProviderCall(calls, 'summary'), calls[0]);
  assert.equal(calls.length, 1);
});

test('recognizes captured HTTP200 provider overload followed by the successful adapter retry', () => {
  const calls = [{ kind: 'summary', status: 200, response: { status: 'failed', error: { code: 'server_error' } } }, completedSummary()];
  assert.equal(assertSingleCompletedProviderCall(calls, 'summary'), calls[1]);
  assert.equal(calls.length, 2);
});

test('recognizes failed transport attempts without declaring their costs or responses available', () => {
  const calls = [{ kind: 'summary' }, { kind: 'summary', status: 503 }, completedSummary()];
  assert.equal(assertSingleCompletedProviderCall(calls, 'summary'), calls[2]);
  assert.equal(calls[0].usage, undefined);
});

test('rejects duplicate completed summaries', () => {
  assert.throws(() => assertSingleCompletedProviderCall([completedSummary(), completedSummary()], 'summary'));
});

test('rejects incomplete or errored envelopes even with HTTP200', () => {
  for (const response of [{ status: 'incomplete' }, { status: 'completed', error: { code: 'server_error' } }]) {
    assert.throws(() => assertSingleCompletedProviderCall([{ kind: 'summary', status: 200, response }], 'summary'));
  }
});

test('rejects an incomplete output before a completion, or a failure after it', () => {
  assert.throws(() => assertSingleCompletedProviderCall([{ kind: 'summary', status: 200, response: { status: 'incomplete' } }, completedSummary()], 'summary'));
  assert.throws(() => assertSingleCompletedProviderCall([completedSummary(), { kind: 'summary', status: 503 }], 'summary'));
});

for (const text of [
  'Active: User requested a summary of the conversation.',
  'Active: Summarizing the conversation per user request.',
  'Next Move: Provide the summary as requested.',
  'Next Move: Emit the sections as requested.',
]) {
  test('rejects captured compaction task contamination: ' + text, () => {
    assert.equal(hasCompactionTaskLeak(text), true);
  });
}

test('accepts the captured explicit absence of a source request', () => {
  assert.equal(hasCompactionTaskLeak('Unspecified — no new user request beyond the compaction control.'), false);
});

test('still rejects a separate positive claim after that negative statement', () => {
  assert.equal(hasCompactionTaskLeak('Unspecified — no new user request beyond the compaction control.\nActive: Preparing a summary.'), true);
});

test('accepts the actual receipt task and unspecified next action', () => {
  assert.equal(hasCompactionTaskLeak('User repeatedly requests JSON output containing the current observation receipt.\nNext Move: Unspecified.'), false);
});

const instruction = 'Never publish.', currentObservation = 'Current receipt is abc.';
const canonicalBeforeReply = [
  { id: 'u1', role: 'user', content: instruction },
  { id: 'a1', role: 'assistant', content: 'Old observation.' },
  { id: 'u2', role: 'user', content: 'Accepted correction: read only.' },
  { id: 'a2', role: 'assistant', content: currentObservation },
  { id: 'u3', role: 'user', content: 'Return the current receipt.' },
];
const fallback = () => ({ wire: [{ role: 'system', content: 'Original contract.' }, ...canonicalBeforeReply],
  canonicalBeforeReply, currentObservation, instruction, previousArtifact: { id: 'durable' }, artifact: { id: 'durable' } });

test('accepts complete canonical wire with the unchanged durable cache', () => {
  assert.doesNotThrow(() => assertCompleteCanonicalFallback(fallback()));
});

for (const [name, mutate] of [
  ['missing current observation', value => { value.wire = value.wire.filter(message => message.id !== 'a2'); }],
  ['missing older accepted correction', value => { value.wire = value.wire.filter(message => message.id !== 'u2'); }],
  ['stale summary on the wire', value => { value.wire.push({ role: 'assistant', content: '[FLUJO conversation summary]' }); }],
  ['changed durable artifact', value => { value.artifact.id = 'replacement'; }],
]) {
  test('rejects an unsafe fallback: ' + name, () => {
    const value = fallback(); mutate(value);
    assert.throws(() => assertCompleteCanonicalFallback(value));
  });
}
