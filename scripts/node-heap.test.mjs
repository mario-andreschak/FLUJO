import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { scaledHeapMegabytes, withScaledHeap } from '../bin/node-heap.mjs';
import { withDevelopmentHeap } from './launch-next.mjs';
import { compilerNodeArgs } from './run-tsc.mjs';

const GB = 1024 ** 3;

test('a small computer gives most of its memory, not Node\'s 2 GB default', () => {
  assert.equal(scaledHeapMegabytes({ total: 8 * GB, constrained: 0, defaultLimit: 2 * GB }), 6144);
  assert.equal(scaledHeapMegabytes({ total: 7 * GB, constrained: 0, defaultLimit: 2 * GB }), 5376);
});

test('the heap follows a container memory limit and stops at 8 GB on large computers', () => {
  assert.equal(scaledHeapMegabytes({ total: 64 * GB, constrained: 4 * GB, defaultLimit: 2 * GB }), 3072);
  assert.equal(scaledHeapMegabytes({ total: 64 * GB, constrained: 0, defaultLimit: 4 * GB }), 8192);
});

test('the heap is never smaller than what Node would pick by itself', () => {
  assert.equal(scaledHeapMegabytes({ total: 2 * GB, constrained: 0, defaultLimit: 2 * GB }), 2048);
});

test('a heap size already set in NODE_OPTIONS wins', () => {
  assert.equal(withScaledHeap('--max-old-space-size=4096 --use-system-ca', 6144), '--max-old-space-size=4096 --use-system-ca');
  assert.equal(withScaledHeap('--use-system-ca', 6144), '--use-system-ca --max-old-space-size=6144');
  assert.equal(withScaledHeap(undefined, 6144), '--max-old-space-size=6144');
  assert.deepEqual(compilerNodeArgs({ NODE_OPTIONS: '--max-old-space-size 4096' }, 6144), []);
  assert.deepEqual(compilerNodeArgs({}, 6144), ['--max-old-space-size=6144']);
});

test('only the development server gets the scaled heap', () => {
  const env = { NODE_OPTIONS: '--use-system-ca', OTHER: 'kept' };
  const dev = withDevelopmentHeap(env, ['dev', '--webpack', '-p', '4300']);
  assert.match(dev.NODE_OPTIONS, /^--use-system-ca --max-old-space-size=\d+$/);
  assert.equal(dev.OTHER, 'kept');
  assert.equal(env.NODE_OPTIONS, '--use-system-ca', 'the caller\'s environment is not changed');
  assert.equal(withDevelopmentHeap(env, ['start', '-p', '4200']), env);
  assert.equal(withDevelopmentHeap({ NODE_OPTIONS: '--max-old-space-size=4096' }, ['dev']).NODE_OPTIONS, '--max-old-space-size=4096');
});

test('npm run typecheck runs the compiler through the scaling launcher', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.typecheck, 'next typegen && node scripts/run-tsc.mjs --noEmit -p tsconfig.json');
});
