import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { main } from './run.mjs';
import { FIRST_RUN_TASKS, TASKS } from './tasks.mjs';
import { TESTERS, pickTesters } from './testers.mjs';

test('plays every day-one task of the tester guide, in its order, each with a fixed rule', () => {
  assert.deepEqual(TASKS.map((task) => task.id), ['connect-ai', 'app-tool', 'build-agent', 'approve-reject', 'debugger', 'reuse-app', 'diagnostic-report']);
  const guide = readFileSync(new URL('../../docs/pilots/product-fit/tester-guide.md', import.meta.url), 'utf8');
  for (const heading of ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6', 'Share a diagnostic report']) {
    assert.ok(guide.includes(heading), `the tester guide lost "${heading}"`);
    assert.ok(TASKS.some((task) => task.title.startsWith(heading)), `no scripted task for "${heading}"`);
  }
  for (const task of TASKS) {
    assert.ok(Number.isInteger(task.limitSeconds) && task.limitSeconds > 0 && task.limitSeconds <= 300, task.id);
    assert.ok(task.expected && typeof task.run === 'function', task.id);
  }
  assert.deepEqual(FIRST_RUN_TASKS, TASKS.slice(0, 3).map((task) => task.id));
});

test('several first-time users on different screens', () => {
  assert.ok(TESTERS.length >= 3);
  assert.equal(new Set(TESTERS.map((tester) => `${tester.viewport.width}x${tester.viewport.height}`)).size, TESTERS.length);
  assert.deepEqual(pickTesters('p03-phone,p01-desk').map((tester) => tester.id), ['p01-desk', 'p03-phone']);
  assert.throws(() => pickTesters('p09'), /Unknown tester p09/);
});

test('prints help without starting anything', async () => {
  const lines = [];
  assert.equal(await main(['--help'], (line) => lines.push(line)), 0);
  assert.match(lines.join('\n'), /port 4200/);
});

test('refuses an unknown mode before starting FLUJO', async () => {
  await assert.rejects(main(['--mode', 'fast'], () => {}), /--mode must be start or dev/);
});
