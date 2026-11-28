import assert from 'node:assert/strict';
import test from 'node:test';
import { GOAL, STAGES, main } from './goal-check.mjs';

test('the goal check sets up an AI and an agent, then sets a goal, watches it finish and tries the other commands', () => {
  assert.deepEqual(STAGES.map((stage) => stage.id), ['setup', 'set-goal', 'goal-rounds', 'goal-status', 'slash-commands']);
  for (const stage of STAGES) assert.ok(stage.title && typeof stage.run === 'function', stage.id);
  assert.ok(GOAL.length > 0 && !GOAL.startsWith('/'));
});

test('never drives the everyday FLUJO on port 4200', async () => {
  await assert.rejects(main(['--base-url', 'http://127.0.0.1:4200/'], () => {}), /port 4200/);
});

test('prints help without starting anything', async () => {
  const lines = [];
  assert.equal(await main(['--help'], (line) => lines.push(line)), 0);
  assert.match(lines.join('\n'), /npm run drive -- launch/);
});
