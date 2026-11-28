#!/usr/bin/env node
// Runs the TypeScript compiler with a heap that follows the machine: checking the whole app
// needs about 4 GB, more than Node's 2 GB default on computers with less than 15 GB (#1441).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { scaledHeapMegabytes, setsHeap } from '../bin/node-heap.mjs';

const require = createRequire(import.meta.url);

/** Node arguments for the compiler: the scaled heap, unless NODE_OPTIONS already sets one. */
export function compilerNodeArgs(env = process.env, heap = scaledHeapMegabytes()) {
  return setsHeap(env.NODE_OPTIONS) ? [] : [`--max-old-space-size=${heap}`];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const child = spawn(process.execPath, [...compilerNodeArgs(), require.resolve('typescript/bin/tsc'), ...process.argv.slice(2)], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
