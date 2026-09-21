import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePersonaSoakNumericEvidence } from './validate-persona-soak-artifacts.mjs';

function report() {
  return {
    runIdentity: { days: 28, activitiesPerDay: 20 },
    metrics: Array.from({ length: 28 }, (_, index) => ({
      day: index + 1,
      residentMemoryBytes: 300 * 1024 * 1024,
      eventAppendP95Ms: 10,
      recallP95Ms: 5,
      recallPrecision: 1,
      collectionCounts: { mailboxItems: 627, activities: 563, flowDispatches: 497, leaseHistory: 50, behaviorCallPins: 400 },
      collectionUncompactedCounts: { mailboxItems: 500, activities: 200, flowDispatches: 200, leaseHistory: 50, behaviorCallPins: 200 },
    })),
    criteria: [{ id: 'resident-memory-bound', status: 'passed' }],
  };
}

test('accepts the actual numeric boundaries but rejects a forged passing RSS label', () => {
  const value = report();
  value.metrics.at(-1).residentMemoryBytes += 256 * 1024 * 1024;
  assert.deepEqual(validatePersonaSoakNumericEvidence(value, 'acceptance'), []);
  value.metrics.at(-1).residentMemoryBytes += 1;
  assert.match(validatePersonaSoakNumericEvidence(value, 'acceptance').join(), /resident-memory-bound/);
  value.metrics.at(-1).residentMemoryBytes = 300 * 1024 * 1024;
  value.metrics[10].residentMemoryBytes = 768 * 1024 * 1024 + 1;
  assert.match(validatePersonaSoakNumericEvidence(value, 'infrastructure').join(), /resident-memory-bound/);
});

test('independently enforces the append ceiling, trend and noise floor', () => {
  const value = report();
  for (const metric of value.metrics.slice(-7)) metric.eventAppendP95Ms = 20;
  assert.deepEqual(validatePersonaSoakNumericEvidence(value, 'acceptance'), []);
  for (const metric of value.metrics.slice(-7)) metric.eventAppendP95Ms = 21;
  assert.match(validatePersonaSoakNumericEvidence(value, 'acceptance').join(), /flat-event-append-cost/);
  for (const metric of value.metrics) metric.eventAppendP95Ms = 100;
  assert.deepEqual(validatePersonaSoakNumericEvidence(value, 'acceptance'), []);
  value.metrics[5].eventAppendP95Ms = 150;
  assert.match(validatePersonaSoakNumericEvidence(value, 'acceptance').join(), /flat-event-append-cost/);
});

test('rejects missing, excessive or uncontracted collection counts', () => {
  for (const mutate of [
    value => { delete value.metrics[0].collectionCounts.activities; },
    value => { value.metrics[0].collectionCounts.activities = 1249; },
    value => { value.metrics[0].collectionCounts.extra = 1; },
    value => { value.metrics[0].collectionUncompactedCounts.flowDispatches = 201; },
    value => { delete value.metrics[0].collectionCounts.behaviorCallPins; },
    value => { value.metrics[0].collectionUncompactedCounts.behaviorCallPins = 201; },
  ]) {
    const value = report();
    mutate(value);
    assert.match(validatePersonaSoakNumericEvidence(value, 'acceptance').join(), /bounded-detailed-runtime-state/);
  }
});

test('requires finite recall, append and RSS observations and enforces recall bounds', () => {
  for (const field of ['recallP95Ms', 'recallPrecision', 'eventAppendP95Ms', 'residentMemoryBytes']) {
    const value = report();
    delete value.metrics[0][field];
    assert.match(validatePersonaSoakNumericEvidence(value, 'acceptance').join(), /missing or invalid/);
  }
  const value = report();
  value.metrics.at(-1).recallP95Ms = 150;
  value.metrics.at(-1).recallPrecision = 0.94;
  assert.equal(validatePersonaSoakNumericEvidence(value, 'smoke').length, 2);
});
