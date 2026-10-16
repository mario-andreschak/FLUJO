import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProtectedState, protectedCases, protectedCorrection, protectedInstruction, protectedDeveloper } from './compaction-protected-state.mjs';

const fixture = () => {
  const fields = protectedCases[0], corrections = [protectedCorrection(fields)];
  return { fields, corrections, answer: { ...fields, sendAllowed: false, unknown: null }, transform: 'emergency',
    calls: [{ kind: 'continuation', status: 200, request: { input: [
      { role: 'system', content: protectedDeveloper }, { role: 'user', content: protectedInstruction },
      { role: 'user', content: corrections[0] }, { role: 'assistant', content: '[FLUJO emergency context compaction]\nold prose omitted' },
    ] }, response: { status: 'completed', output: [] } }] };
};
test('accepts complete protected traffic and the literal latest answer', () => assert(assertProtectedState(fixture()).exactReply));
test('rejects a plausible answer when original authority vanished', () => {
  const value = fixture(); value.calls[0].request.input.splice(1, 1);
  assert.throws(() => assertProtectedState(value), /prohibition/);
});
test('rejects instruction role laundering', () => {
  const value = fixture(); value.calls[0].request.input[1].role = 'assistant';
  assert.throws(() => assertProtectedState(value), /prohibition/);
});
test('rejects reversed accepted corrections', () => {
  const value = fixture(), next = protectedCorrection(protectedCases[1]); value.corrections.push(next);
  value.calls[0].request.input.splice(2, 0, { role: 'user', content: next });
  assert.throws(() => assertProtectedState(value), /correction/);
});
test('requires the actual transform marker', () => {
  const value = fixture(); value.calls[0].request.input.pop();
  assert.throws(() => assertProtectedState(value), /Emergency omission/);
});
test('rejects an invented grant and generated tool calls', () => {
  const value = fixture(); value.answer.sendAllowed = true;
  assert.throws(() => assertProtectedState(value)); value.answer.sendAllowed = false;
  value.calls[0].response.output.push({ type: 'function_call', name: 'send_message' });
  assert.throws(() => assertProtectedState(value), /must not execute/);
});
test('rejects lost tool pairs even with a correct final answer', () => {
  const value = fixture(); value.calls[0].request.input.push({ type: 'function_call_output', call_id: 'orphan', output: 'done' });
  assert.throws(() => assertProtectedState(value), /Orphan/);
});
test('checks failed outbound attempts as well as the successful retry', () => {
  const value = fixture(), failed = structuredClone(value.calls[0]); failed.status = 503; failed.response = { status: 'failed' };
  failed.request.input.splice(1, 1); value.calls.unshift(failed);
  assert.throws(() => assertProtectedState(value), /prohibition/);
});
