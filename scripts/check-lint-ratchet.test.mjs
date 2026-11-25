import assert from 'node:assert/strict';
import test from 'node:test';
import { describeGrowth, findGrowth, findNewFileEntries, parseNameStatus } from './check-lint-ratchet.mjs';

const entry = (rules) => Object.fromEntries(Object.entries(rules).map(([rule, count]) => [rule, { count }]));

test('a shrinking or unchanged list passes', () => {
  const base = { 'src/a.tsx': entry({ 'flujo/no-raw-timers': 3 }), 'src/b.ts': entry({ 'flujo/no-sync-fs': 1 }) };
  const current = { 'src/a.tsx': entry({ 'flujo/no-raw-timers': 2 }) };
  assert.deepEqual(findGrowth(base, current), []);
});

test('a higher count, a new rule or a new file is growth', () => {
  const base = { 'src/a.tsx': entry({ 'flujo/no-raw-timers': 1 }) };
  const current = {
    'src/a.tsx': entry({ 'flujo/no-raw-timers': 2, 'flujo/no-double-cast': 1 }),
    'src/new.ts': entry({ 'flujo/no-sync-fs': 1 }),
  };
  assert.deepEqual(findGrowth(base, current), [
    { file: 'src/a.tsx', rule: 'flujo/no-raw-timers', allowed: 1, count: 2 },
    { file: 'src/a.tsx', rule: 'flujo/no-double-cast', allowed: 0, count: 1 },
    { file: 'src/new.ts', rule: 'flujo/no-sync-fs', allowed: 0, count: 1 },
  ]);
});

test('a renamed file keeps the allowance of its old path', () => {
  const { renames, added } = parseNameStatus('M\tsrc/x.ts\nR097\tsrc/old.tsx\tsrc/moved/new.tsx\nA\tsrc/y.ts\n');
  assert.deepEqual([...renames], [['src/moved/new.tsx', 'src/old.tsx']]);
  assert.deepEqual([...added], ['src/y.ts']);
  const base = { 'src/old.tsx': entry({ 'react-hooks/refs': 2 }) };
  assert.deepEqual(findGrowth(base, { 'src/moved/new.tsx': entry({ 'react-hooks/refs': 2 }) }, renames), []);
  assert.equal(findGrowth(base, { 'src/moved/new.tsx': entry({ 'react-hooks/refs': 3 }) }, renames).length, 1);
});

test('when the list first arrives, only files that already existed may be listed', () => {
  const current = { 'src/old.tsx': entry({ 'react-hooks/refs': 4 }), 'src/frontend/hooks/new.ts': entry({ 'react-hooks/immutability': 1 }) };
  assert.deepEqual(findNewFileEntries(current, new Set(['src/frontend/hooks/new.ts', 'docs/x.md'])), [
    { file: 'src/frontend/hooks/new.ts', rule: 'react-hooks/immutability', allowed: 0, count: 1 },
  ]);
});

test('the failure message tells the reader to fix the code, not the list', () => {
  const message = describeGrowth([{ file: 'src/a.tsx', rule: 'flujo/no-raw-timers', allowed: 0, count: 1 }]);
  assert.match(message, /src\/a\.tsx {2}flujo\/no-raw-timers {2}0 -> 1/);
  assert.match(message, /Fix the new code instead/);
  assert.match(message, /--suppress-all/);
});
