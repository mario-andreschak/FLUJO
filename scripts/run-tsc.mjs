#!/usr/bin/env node
// Runs the TypeScript compiler with a heap that fits this project and the machine. Checking the
// whole app needs more than the 2 GB Node gives itself on computers with less than 15 GB of
// memory, where `npm run typecheck` ran out of memory (#1441). A heap size the caller already
// set in NODE_OPTIONS wins.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';

const require = createRequire(import.meta.url);
const MB = 1024 * 1024;
const SHARE_OF_MEMORY = 0.75;
const MOST_MB = 8192;

/** Three quarters of the memory this process may use, at most 8 GB, and never less than Node's own default. */
export function typecheckHeapMegabytes({
  total = os.totalmem(),
  constrained = process.constrainedMemory?.() ?? 0,
  defaultLimit = v8.getHeapStatistics().heap_size_limit,
} = {}) {
  const memory = constrained > 0 ? Math.min(total, constrained) : total;
  return Math.max(Math.floor(defaultLimit / MB), Math.min(MOST_MB, Math.floor((memory / MB) * SHARE_OF_MEMORY)));
}

/** Node arguments for the compiler: the scaled heap, unless NODE_OPTIONS already sets one. */
export function compilerNodeArgs(env = process.env, heap = typecheckHeapMegabytes()) {
  return /--max-old-space-size[=\s]/.test(env.NODE_OPTIONS ?? '') ? [] : [`--max-old-space-size=${heap}`];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const child = spawn(process.execPath, [...compilerNodeArgs(), require.resolve('typescript/bin/tsc'), ...process.argv.slice(2)], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
