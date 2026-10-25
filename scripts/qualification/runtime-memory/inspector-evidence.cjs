'use strict';
const assert = require('node:assert/strict');

function allocationWindowLabel({ mode, epoch, number, elapsedMs, scheduledMs, durationMs, cadenceMs, baselineTaken, baselineStartMs }) {
  if (epoch === 'warmup') return number === -1 ? 'warmup' : undefined;
  const final = scheduledMs + cadenceMs >= durationMs;
  const baseline = !baselineTaken && (mode === 'pilot' || elapsedMs >= baselineStartMs);
  assert(!(baseline && final), 'Baseline and final allocation windows require distinct batches');
  return final ? 'final' : baseline ? 'hour-two' : undefined;
}

class BatchAllocationSampler {
  constructor(begin, publish, now) { this.begin = begin; this.publish = publish; this.now = now; this.active = false; this.labels = new Set(); }
  async run(label, epoch, number, runBatch) {
    assert(!this.active, 'Allocation windows cannot overlap');
    assert(!this.labels.has(label) && this.labels.size < 3, 'Allocation window repeated or exceeded');
    this.active = true; this.labels.add(label);
    try {
      // begin resolves only after HeapProfiler.startSampling acknowledges readiness.
      const window = await this.begin();
      const settled = window.done.then(value => ({ value }), error => ({ error }));
      const batchStartedAtMs = this.now();
      let result, failure;
      try { result = await runBatch(); } catch (error) { failure = error; }
      const batchEndedAtMs = this.now();
      const outcome = await settled;
      if (outcome.error) throw outcome.error;
      const { endedAtMs, summary } = outcome.value;
      const overlapMs = Math.min(endedAtMs, batchEndedAtMs) - Math.max(window.startedAtMs, batchStartedAtMs);
      assert(overlapMs > 0, 'Allocation window did not overlap its batch');
      this.publish({ label, epoch, batch: number, windowStartedAtMs: window.startedAtMs, windowEndedAtMs: endedAtMs,
        actualDurationMs: endedAtMs - window.startedAtMs, batchStartedAtMs, batchEndedAtMs,
        batchOverlapMs: overlapMs, batchCompleted: !failure, ...summary });
      if (failure) throw failure;
      return result;
    } finally { this.active = false; }
  }
}
module.exports = { allocationWindowLabel, BatchAllocationSampler };
