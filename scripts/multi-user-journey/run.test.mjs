import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSteps } from '../flujo-drive.mjs';
import { journeyPeople, main, teamStages } from './run.mjs';

test('the team journey covers what a person checked by hand, in order', () => {
  const stages = teamStages(journeyPeople('abc123'));
  assert.deepEqual(stages.map((stage) => stage.id), [
    'anna-turns-on-sign-in', 'anna-adds-ben', 'ben-signs-in', 'anna-makes-team', 'anna-builds-team-agent', 'ben-opens-team-workspace', 'both-open-the-agent',
    'conflict', 'history-and-restore', 'ben-copies-into-team', 'anna-removes-ben', 'ben-is-cut-off', 'anna-turns-off-sign-in',
  ]);
  for (const stage of stages) {
    const lists = Array.isArray(stage.steps) ? [stage.steps] : Object.values(stage.steps);
    for (const steps of lists) if (steps.length) assert.doesNotThrow(() => validateSteps(steps), stage.id);
  }
});

test('every run makes its own names and passwords, and the passwords never repeat', () => {
  const first = journeyPeople();
  const second = journeyPeople();
  assert.notEqual(first.anna.password, second.anna.password);
  assert.notEqual(first.workspace, second.workspace);
  assert.ok(first.anna.password.length >= 15, 'FLUJO asks for at least 15 characters');
});

test('prints help without starting anything', async () => {
  const lines = [];
  assert.equal(await main(['--help'], (line) => lines.push(line)), 0);
  assert.match(lines.join('\n'), /npm run\s+build/);
});
