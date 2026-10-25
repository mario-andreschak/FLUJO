'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PROFILE } = require('./profile.cjs');
class BoundedJsonl {
  constructor(file, cap = PROFILE.maxEvidenceFileBytes) { this.fd = fs.openSync(file, 'wx'); this.bytes = 0; this.cap = cap; }
  write(value) {
    const line = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(line);
    assert(bytes <= 64 * 1024 && this.bytes + bytes <= this.cap, 'Evidence byte allowance exhausted');
    fs.writeSync(this.fd, line); this.bytes += bytes;
  }
  close() { if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; } }
}
async function directoryBytes(root) {
  let bytes = 0, files = 0;
  async function visit(directory, depth) {
    assert(depth <= 32, 'Data tree depth exceeds contract');
    for await (const item of await fs.promises.opendir(directory)) {
      const full = path.join(directory, item.name);
      assert(!item.isSymbolicLink(), 'Data tree contains a link');
      if (item.isDirectory()) await visit(full, depth + 1);
      else if (item.isFile()) { bytes += (await fs.promises.stat(full)).size; files++; }
      else throw new Error('Unexpected data tree entry');
      assert(files <= 2_000_000 && Number.isSafeInteger(bytes), 'Data inventory allowance exhausted');
    }
  }
  await visit(root, 0); return { bytes, files };
}
class DrainWindows {
  constructor() { this.hours = new Map(); }
  add(elapsedMs, memory) {
    const hour = Math.floor(elapsedMs / 3_600_000);
    if (hour < 2 || hour > 23) return;
    const entry = this.hours.get(hour) ?? { samples: 0, heapUsed: Infinity, rss: Infinity, external: Infinity, arrayBuffers: Infinity, heapPlusExternal: Infinity };
    entry.samples++;
    for (const field of ['heapUsed', 'rss', 'external', 'arrayBuffers']) entry[field] = Math.min(entry[field], memory[field]);
    entry.heapPlusExternal = Math.min(entry.heapPlusExternal, memory.heapUsed + memory.external);
    this.hours.set(hour, entry);
  }
  result(required) {
    const hours = Object.fromEntries(this.hours);
    if (!required) return { metric: 'hourly drained low-water marks; no forced GC, not retained-object proof', hours };
    for (let hour = 2; hour < 24; hour++) assert((hours[hour]?.samples ?? 0) >= 3, 'Insufficient drained samples for hour ' + hour);
    const baseline = hours[2];
    let maxHeapGrowth = 0, maxExternalGrowth = 0, maxArrayBufferGrowth = 0, maxRssGrowth = 0, maxCombinedGrowth = 0;
    for (let hour = 3; hour < 24; hour++) {
      maxHeapGrowth = Math.max(maxHeapGrowth, hours[hour].heapUsed - baseline.heapUsed);
      maxExternalGrowth = Math.max(maxExternalGrowth, hours[hour].external - baseline.external);
      maxArrayBufferGrowth = Math.max(maxArrayBufferGrowth, hours[hour].arrayBuffers - baseline.arrayBuffers);
      maxRssGrowth = Math.max(maxRssGrowth, hours[hour].rss - baseline.rss);
      maxCombinedGrowth = Math.max(maxCombinedGrowth, hours[hour].heapPlusExternal - baseline.heapPlusExternal);
    }
    assert(maxHeapGrowth <= PROFILE.budgets.retainedGrowth, 'Drained heap low-water growth exceeds 128 MiB');
    assert(maxExternalGrowth <= PROFILE.budgets.retainedGrowth, 'External low-water growth exceeds 128 MiB');
    assert(maxArrayBufferGrowth <= PROFILE.budgets.retainedGrowth, 'ArrayBuffer low-water growth exceeds 128 MiB');
    assert(maxRssGrowth <= PROFILE.budgets.retainedGrowth, 'RSS low-water growth exceeds 128 MiB');
    assert(maxCombinedGrowth <= PROFILE.budgets.retainedGrowth, 'Combined heap+external low-water growth exceeds 128 MiB');
    return { metric: 'hourly drained low-water marks; no forced GC, not retained-object proof', hours,
      maxHeapGrowth, maxExternalGrowth, maxArrayBufferGrowth, maxRssGrowth, maxCombinedGrowth };
  }
}
module.exports = { BoundedJsonl, directoryBytes, DrainWindows };
