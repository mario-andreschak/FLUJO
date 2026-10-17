import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { protectedCases, protectedCorrection, protectedInstruction } from './compaction-protected-state.mjs';
import { assertSingleCompletedProviderCall } from './compaction-source-task-check.mjs';

export { protectedInstruction };

// A review can read new tool evidence and then compact again. Require one
// successful summary for each distinct actual source, allowing failed transport
// retries without treating changed source as duplicate summary generation.
export function assertSummarySources(calls, { allowRejectedSources = false } = {}) {
  const sources = new Map();
  for (const call of calls.filter(value => value.kind === 'summary')) {
    const input = call.request.input ?? call.request.messages;
    assert(Array.isArray(input) && input.length, 'Actual summary source input is required');
    const key = JSON.stringify({ model: call.request.model, input });
    if (!sources.has(key)) sources.set(key, []);
    sources.get(key).push(call);
  }
  assert(sources.size, 'A fresh real summary is required for each changed prefix');
  const verified = [...sources].map(([key, attempts]) => {
    const completed = attempts.filter(call => call.status === 200 && call.response?.status === 'completed' && !call.response.error);
    const sourceSha256 = createHash('sha256').update(key).digest('hex');
    if (allowRejectedSources && completed.length === 0) {
      assert(attempts.every(call => call.status === undefined || call.status >= 500
        || ['failed', 'incomplete'].includes(call.response?.status)), 'An unclassified summary result cannot be credited');
      return { sourceSha256, attempts: attempts.length, completed: false };
    }
    assertSingleCompletedProviderCall(attempts, 'summary');
    return { sourceSha256, attempts: attempts.length, completed: true };
  });
  assert(verified.some(source => source.completed), 'At least one fresh completed summary is required');
  return verified;
}

export function assertUncertainActionNotConsulted(calls, actionId) {
  const committed = calls.findIndex(call => call.tool === 'commit_action' && call.actionId === actionId);
  assert(committed >= 0, 'The actual uncertain write must be present in the ledger');
  assert.equal(calls.slice(committed + 1).filter(call => call.tool === 'lookup_action' && call.actionId === actionId).length, 0,
    'The uncertain action must await the user reconciliation request');
}

export function assertExternalObservations(calls, round) {
  assert(Number.isInteger(round) && round >= 0 && round <= 10);
  const reads = calls.filter(call => call.tool === 'read_observation');
  assert.deepEqual(reads.map(call => call.round), Array.from({ length: round + 1 }, (_, index) => index),
    'Each genuine external observation must be read once, without peeking ahead or replaying an old observation');
  assert(reads.every(call => call.result && call.result.isError !== true),
    'An error-shaped MCP result cannot count as a successful external observation');
}

// Move the current correction within one trusted source message. Earlier
// corrections stay in canonical order; historical prose grants no authority.
export function rotatedActionCorrection(round) {
  assert(Number.isInteger(round) && round >= 1 && round <= 10);
  const fields = protectedCases[round - 1];
  const correction = protectedCorrection(fields);
  const padding = 'Nota histórica sin permiso nuevo. '.repeat(12);
  const position = ['early', 'middle', 'late'][(round - 1) % 3];
  const content = position === 'early' ? correction + '\n' + padding + padding
    : position === 'middle' ? padding + '\n' + correction + '\n' + padding
      : padding + padding + '\n' + correction;
  return { fields, correction, content, position, sourceOffset: content.indexOf(correction) };
}

// Compare against actual provider output, never reconstructed Chat messages.
// A fixture that keeps only text or drops a phase/ID must fail this check.
export function assertRestartWindows(records, input) {
  assert(Array.isArray(records) && records.length, 'A durable native checkpoint is required');
  assert(Array.isArray(input));
  let cursor = 0;
  const windows = [];
  for (const [, record] of records) {
    const output = record.nativeOutput;
    assert(Array.isArray(output) && output.length && output[0].id);
    const index = input.findIndex((item, position) => position >= cursor && item.id === output[0].id);
    assert(index >= cursor, 'A checkpointed provider window disappeared after restart');
    assert.deepEqual(input.slice(index, index + output.length), output,
      'A checkpointed provider window changed after restart');
    cursor = index + output.length;
    windows.push({ firstId: output[0].id, items: output.length, index });
  }
  return windows;
}
