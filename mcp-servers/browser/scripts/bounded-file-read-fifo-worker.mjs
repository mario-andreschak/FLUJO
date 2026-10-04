import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [helper, fifo] = process.argv.slice(2);
const { readBoundedRegularFile } = await import(pathToFileURL(helper));
let opened = 0;
let contentReads = 0;
let closed = 0;
let closedDescriptor = false;
let fifoObserved = false;
const originalOpen = fs.open;
fs.open = async (...args) => {
  const handle = await Reflect.apply(originalOpen, fs, args);
  opened++;
  const originalStat = handle.stat.bind(handle);
  handle.stat = async (...statArgs) => {
    const stat = await originalStat(...statArgs);
    fifoObserved = stat.isFIFO();
    return stat;
  };
  for (const method of ['read', 'readFile', 'createReadStream']) {
    const original = handle[method].bind(handle);
    handle[method] = (...readArgs) => { contentReads++; return original(...readArgs); };
  }
  const originalClose = handle.close.bind(handle);
  handle.close = async () => {
    await originalClose();
    closed++;
    closedDescriptor = handle.fd === -1;
  };
  return handle;
};
const started = performance.now();
const result = await readBoundedRegularFile(fifo, 8);
const elapsedMs = performance.now() - started;
process.send({ status: result.status, fifoObserved, opened, contentReads, closed, closedDescriptor,
  elapsedMs, node: process.version, platform: process.platform }, () => process.disconnect());
