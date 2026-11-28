import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compilerNodeArgs, typecheckHeapMegabytes } from './run-tsc.mjs';

const GB = 1024 ** 3;

test('the type check gets most of a small computer\'s memory, not Node\'s 2 GB default', () => {
  assert.equal(typecheckHeapMegabytes({ total: 8 * GB, constrained: 0, defaultLimit: 2 * GB }), 6144);
  assert.equal(typecheckHeapMegabytes({ total: 7 * GB, constrained: 0, defaultLimit: 2 * GB }), 5376);
});

test('the heap follows a container memory limit and stops at 8 GB on large computers', () => {
  assert.equal(typecheckHeapMegabytes({ total: 64 * GB, constrained: 4 * GB, defaultLimit: 2 * GB }), 3072);
  assert.equal(typecheckHeapMegabytes({ total: 64 * GB, constrained: 0, defaultLimit: 4 * GB }), 8192);
});

test('the heap is never smaller than what Node would pick by itself', () => {
  assert.equal(typecheckHeapMegabytes({ total: 2 * GB, constrained: 0, defaultLimit: 2 * GB }), 2048);
});

test('a heap size set in NODE_OPTIONS wins', () => {
  assert.deepEqual(compilerNodeArgs({ NODE_OPTIONS: '--max-old-space-size=4096' }, 6144), []);
  assert.deepEqual(compilerNodeArgs({ NODE_OPTIONS: '--use-system-ca' }, 6144), ['--max-old-space-size=6144']);
  assert.deepEqual(compilerNodeArgs({}, 6144), ['--max-old-space-size=6144']);
});

test('npm run typecheck runs the compiler through this script', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.typecheck, 'next typegen && node scripts/run-tsc.mjs --noEmit -p tsconfig.json');
});
