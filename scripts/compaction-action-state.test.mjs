import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRestartWindows, rotatedActionCorrection, assertUncertainActionNotConsulted, assertSummarySources } from './compaction-action-state.mjs';

const summaryAttempt = (input, status = 'completed') => ({ kind: 'summary', status: 200,
  request: { model: 'approved-model', input }, response: { status } });

test('a review can summarize again after real tool evidence changes its source', () => {
  const first = [{ role: 'user', content: 'Check both receipts.' }];
  const second = [...first, { role: 'tool', content: 'new lookup receipt' }];
  const sources = assertSummarySources([summaryAttempt(first, 'failed'), summaryAttempt(first), summaryAttempt(second)]);
  assert.equal(sources.length, 2);
  assert.notEqual(sources[0].sourceSha256, sources[1].sourceSha256);
  assert.deepEqual(sources.map(value => value.attempts), [2, 1]);
});

test('summary evidence refuses duplicate completions, missing source, and no completed summary', () => {
  const source = [{ role: 'user', content: 'unchanged source' }];
  assert.throws(() => assertSummarySources([summaryAttempt(source), summaryAttempt(source)]));
  assert.throws(() => assertSummarySources([summaryAttempt(source, 'failed')]));
  assert.throws(() => assertSummarySources([summaryAttempt(undefined)]));
  assert.throws(() => assertSummarySources([]));
});

test('a rejected later summary is recorded while a fresh valid summary remains required', () => {
  const first = [{ role: 'user', content: 'current correction' }];
  const later = [...first, { role: 'tool', content: 'new lookup evidence' }];
  const options = { allowRejectedSources: true };
  assert.deepEqual(assertSummarySources([summaryAttempt(first), summaryAttempt(later, 'incomplete')], options)
    .map(source => source.completed), [true, false]);
  assert.throws(() => assertSummarySources([summaryAttempt(first, 'incomplete')], options));
  assert.throws(() => assertSummarySources([summaryAttempt(first), summaryAttempt(first)], options));
});

test('verification of a completed write does not falsely imply premature uncertain-action reconciliation', () => {
  const calls = [{ tool: 'commit_action', actionId: 'completed' }, { tool: 'lookup_action', actionId: 'completed' },
    { tool: 'commit_action', actionId: 'uncertain' }];
  assert.doesNotThrow(() => assertUncertainActionNotConsulted(calls, 'uncertain'));
  assert.throws(() => assertUncertainActionNotConsulted([...calls,
    { tool: 'lookup_action', actionId: 'uncertain' }], 'uncertain'));
});

test('ten corrections rotate exact Spanish fields without reordering their source', () => {
  const cases = Array.from({ length: 10 }, (_, index) => rotatedActionCorrection(index + 1));
  assert.deepEqual(cases.slice(0, 3).map(value => value.position), ['early', 'middle', 'late']);
  assert(cases[0].sourceOffset < cases[1].sourceOffset && cases[1].sourceOffset < cases[2].sourceOffset);
  for (const value of cases) {
    assert.equal(value.content.slice(value.sourceOffset, value.sourceOffset + value.correction.length), value.correction);
    assert(value.correction.includes(value.fields.path));
    assert(value.correction.includes('no cambia ningún permiso'));
  }
  assert.equal(cases[0].fields.destination, cases[4].fields.destination);
  assert.throws(() => rotatedActionCorrection(0));
  assert.throws(() => rotatedActionCorrection(11));
});

test('restart evidence rejects reconstructed, missing, reordered and edited native windows', () => {
  const first = [{ type: 'reasoning', id: 'r1', encrypted_content: 'opaque-ñ', summary: [] },
    { type: 'function_call', id: 'f1', call_id: 'call-1', name: 'commit_action', arguments: '{"actionId":"ñ"}' }];
  const second = [{ type: 'message', id: 'm1', role: 'assistant', phase: 'final', content: [] }];
  const records = [['a', { nativeOutput: first }], ['b', { nativeOutput: second }]];
  const input = [{ role: 'user', content: 'original' }, ...first,
    { type: 'function_call_output', call_id: 'call-1', output: 'receipt' }, ...second];
  assert.equal(assertRestartWindows(records, input).length, 2);
  assert.throws(() => assertRestartWindows(records, [{ role: 'assistant', content: 'receipt' }]));
  assert.throws(() => assertRestartWindows(records, [...second, ...first]));
  const edited = structuredClone(input); delete edited.at(-1).phase;
  assert.throws(() => assertRestartWindows(records, edited));
  const corrupt = structuredClone(input); corrupt[1].encrypted_content += '!';
  assert.throws(() => assertRestartWindows(records, corrupt));
});
