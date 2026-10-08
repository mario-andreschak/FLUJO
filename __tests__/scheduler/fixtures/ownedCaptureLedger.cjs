'use strict';
/** Retain the actual capture object until its real disposer succeeds. */
class OwnedCaptureLedger {
  constructor() { this.pending = new Set(); }
  own(capture) { this.pending.add(capture); return capture; }
  async dispose(capture) {
    if (!this.pending.has(capture)) return;
    if (typeof capture.dispose !== 'function') throw new Error('Owned capture has no disposal proof');
    await capture.dispose();
    this.pending.delete(capture);
  }
  async drain() {
    const failures = [];
    for (const capture of [...this.pending]) {
      try { await this.dispose(capture); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned capture disposal remains unresolved');
  }
}
module.exports = { OwnedCaptureLedger };
