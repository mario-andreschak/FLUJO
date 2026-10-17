import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertBoundedProseRecovery, proseCases, proseObservation } from './compaction-prose-recovery.mjs';

function trace() {
  const sourceText = proseObservation(proseCases[0]);
  const archiveText = JSON.stringify([{ role: 'assistant', content: 'texto '.repeat(12000) + '\n\n' + sourceText }]);
  const start = archiveText.indexOf(JSON.stringify(sourceText).slice(1, -1));
  const locator = { uri: 'flujo://run/owned/source', expected_sha256: createHash('sha256').update(archiveText).digest('hex'),
    start_char: start - 20, max_chars: 1200 };
  const content = archiveText.slice(locator.start_char, locator.start_char + locator.max_chars);
  const result = { uri: locator.uri, sha256: locator.expected_sha256, content,
    verification: { expectedSha256: locator.expected_sha256, actualSha256: locator.expected_sha256, ok: true },
    range: { startChar: locator.start_char, endChar: locator.start_char + content.length } };
  const instruction = 'Nunca envíes mensajes.';
  const call = { type: 'function_call', call_id: 'read-one', name: 'read_resource', arguments: JSON.stringify(locator) };
  const calls = [
    { kind: 'continuation', status: 200, request: { input: [{ role: 'user', content: [{ type: 'input_text', text: instruction }] }] },
      response: { status: 'completed', output: [call] } },
    { kind: 'continuation', status: 200, request: { input: [{ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) },
      { role: 'user', content: [{ type: 'input_text', text: instruction }] }] },
      response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proseCases[0]) }] }] } },
  ];
  const canonical = [{ role: 'assistant', tool_calls: [{ id: call.call_id, function: { name: call.name, arguments: call.arguments } }] },
    { role: 'tool', tool_call_id: call.call_id, content: JSON.stringify(result) }];
  return { calls, canonical, locator, archiveText, sourceText, instruction };
}

test('qualifies exact cross-paragraph Unicode recovery beyond the archive prefix', () => {
  const input = trace();
  const result = assertBoundedProseRecovery(input);
  assert(result.range.startChar > 50000);
  assert(result.contentCharacters <= 1200);
  assert.equal(result.reads, 1);
  assert(!/[0-9"'\/\\`:=]/.test(input.sourceText), 'Fixture prose must avoid the existing exact-field selectors');
  assert.deepEqual(proseCases[0], proseCases.at(-1));
});

test('allows safe summary regeneration when offering the archive reader changes the tool fingerprint', () => {
  const input = trace();
  input.calls.unshift({ kind: 'summary', status: 200, response: { status: 'completed' } });
  assert.equal(assertBoundedProseRecovery(input).reads, 1);
});

for (const [name, mutate] of [
  ['a response without a real read', input => { input.calls[0].response.output = []; }],
  ['a different tool', input => { input.calls[0].response.output[0].name = 'send_message'; }],
  ['a full-resource request', input => { input.calls[0].response.output[0].arguments = JSON.stringify({ uri: input.locator.uri }); }],
  ['a changed archive', input => { input.archiveText += 'changed'; }],
  ['a mismatched call result', input => { input.calls[1].request.input[0].call_id = 'other'; }],
  ['an unverified result', input => {
    const output = input.calls[1].request.input[0]; const value = JSON.parse(output.output);
    value.verification.ok = false; output.output = JSON.stringify(value);
  }],
  ['a plausible rewritten excerpt', input => {
    const output = input.calls[1].request.input[0]; const value = JSON.parse(output.output);
    value.content = value.content.replace('no se realizó', 'se realizó'); output.output = JSON.stringify(value);
  }],
  ['missing original user authority', input => { input.calls[0].request.input = []; }],
  ['an incomplete terminal response', input => { input.calls[1].response.status = 'incomplete'; }],
  ['an extra completed provider response', input => { input.calls.push(structuredClone(input.calls[1])); }],
  ['a duplicated canonical tool result', input => { input.canonical.push(structuredClone(input.canonical[1])); }],
  ['a missing canonical call', input => { input.canonical.shift(); }],
  ['an incomplete summary during recovery', input => { input.calls.unshift({ kind: 'summary', status: 200, response: { status: 'incomplete' } }); }],
]) {
  test('rejects ' + name, () => {
    const input = trace(); mutate(input);
    assert.throws(() => assertBoundedProseRecovery(input));
  });
}
