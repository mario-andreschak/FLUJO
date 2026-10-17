import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPairing, scenario, scoreAnswer, summarizeMatrix, treatments } from './compaction-semantic-protocol.mjs';

test('rotates evidence and preserves immediate temporal state through reversals', () => {
  const cases = Array.from({ length: 10 }, (_, index) => scenario(index + 1));
  assert.deepEqual(new Set(cases.map(row => row.position)), new Set(['early', 'middle', 'late']));
  assert.equal(cases[2].expected.colegioDestino, 'cedro');
  assert.equal(cases[2].expected.colegioAnterior, 'abeto');
  assert.equal(cases[9].expected.colegioAnterior, 'pino');
});

test('does not repair negation, extra prose, unknown types or omitted/extra fields', () => {
  const expected = scenario(1).expected;
  assert(scoreAnswer(JSON.stringify(expected), expected).exact);
  for (const text of [JSON.stringify({ ...expected, sendAllowed: null }),
    JSON.stringify({ ...expected, fechaEnvio: 'null' }), JSON.stringify({ ...expected, sendAllowed: true }),
    'Respuesta: ' + JSON.stringify(expected), JSON.stringify({ ...expected, extra: 'inventado' }), '{}', 'null']) {
    assert.equal(scoreAnswer(text, expected).exact, false, text);
  }
});

test('rejects missing arms and mismatched paired inputs while retaining failed answers', () => {
  const round = { round: 1, questionSha256: 'q', updateSha256: 'u', results: treatments.map(treatment => ({
    treatment, round: 1, questionSha256: 'q', updateSha256: 'u', transformed: treatment !== 'full',
    score: { exact: treatment !== 'anchored' }, reads: [],
  })) };
  assert.deepEqual(summarizeMatrix([round], 1).anchored.failures, [1]);
  const missing = structuredClone(round); missing.results.pop();
  assert.throws(() => summarizeMatrix([missing], 1));
  const changed = structuredClone(round); changed.results[0].questionSha256 = 'different';
  assert.throws(() => summarizeMatrix([changed], 1), /Paired questions/);
});

test('refuses orphaned, unresolved and duplicate historical tool identities', () => {
  const call = { role: 'assistant', tool_calls: [{ id: 'one' }] };
  const result = { role: 'tool', tool_call_id: 'one' };
  assertPairing([call, result]);
  for (const messages of [[result], [call], [call, result, result], [call, result, call, result]]) {
    assert.throws(() => assertPairing(messages));
  }
});
