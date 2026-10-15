import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCompactionTaskLeak, assertCompleteCanonicalFallback } from './compaction-source-task-check.mjs';

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
