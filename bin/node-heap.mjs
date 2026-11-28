// Heap sizes that follow the machine. Node gives itself 2 GB on computers with less than 15 GB
// of memory, and both compiling FLUJO's pages in development and type-checking it need more
// (#1441). A heap size already set in NODE_OPTIONS always wins.
import os from 'node:os';
import process from 'node:process';
import v8 from 'node:v8';

const MB = 1024 * 1024;
const SHARE_OF_MEMORY = 0.75;
const MOST_MB = 8192;
const HEAP_FLAG = /--max-old-space-size[=\s]/;

/** Three quarters of the memory this process may use, at most 8 GB, and never less than Node's own default. */
export function scaledHeapMegabytes({
  total = os.totalmem(),
  constrained = process.constrainedMemory?.() ?? 0,
  defaultLimit = v8.getHeapStatistics().heap_size_limit,
} = {}) {
  const memory = constrained > 0 ? Math.min(total, constrained) : total;
  return Math.max(Math.floor(defaultLimit / MB), Math.min(MOST_MB, Math.floor((memory / MB) * SHARE_OF_MEMORY)));
}

export function setsHeap(nodeOptions = '') {
  return HEAP_FLAG.test(nodeOptions);
}

/** NODE_OPTIONS with the scaled heap added, unless it already sets one. */
export function withScaledHeap(nodeOptions = '', heap = scaledHeapMegabytes()) {
  if (setsHeap(nodeOptions)) return nodeOptions;
  return `${nodeOptions ? `${nodeOptions} ` : ''}--max-old-space-size=${heap}`;
}
