import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadPlan } from '../release-sweep/steps.mjs';
import { MAP_DIR, instanceGroups, main, stepFileChecks } from './run.mjs';
import { SETUPS } from './setups.mjs';

const check = (fields) => ({ id: `x/${fields.label ?? 'a'}`, entry: 'x', label: 'a', steps: [{ do: 'goto', route: '/x' }], ...fields });
const plan = (...checks) => [{ entry: 'x', checks }];

test('every step file the feature map names runs here, and each one that needs setup has it', () => {
  const { checks, problems } = stepFileChecks(loadPlan(MAP_DIR));
  assert.deepEqual(problems, []);
  const named = checks.map((entry) => entry.file).sort();
  assert.deepEqual(named, readdirSync(path.join(MAP_DIR, 'steps')).filter((file) => file.endsWith('.json')).sort());
  for (const entry of checks) assert.equal(entry.steps[0].do, 'goto', `${entry.id} starts with a visit`);
});

test('a setup never outlives its step file', () => {
  for (const file of Object.keys(SETUPS)) assert.ok(existsSync(path.join(MAP_DIR, 'steps', file)), `${file} has a setup but no step file`);
  for (const [file, setup] of Object.entries(SETUPS)) {
    if (setup.env || setup.before) assert.ok(setup.provides, `${file} prepares something, so it says what in "provides"`);
  }
});

test('a step file that needs something no setup provides fails the run with the fix', () => {
  const needs = check({ stepFile: 'docs/feature-map/steps/new.json', status: 'needs', reason: 'needs a Persona' });
  const { checks, problems } = stepFileChecks(plan(needs), {});
  assert.deepEqual(checks, []);
  assert.match(problems[0], /needs a Persona, and scripts\/feature-steps\/setups\.mjs has no setup for new\.json/);
  assert.equal(stepFileChecks(plan(needs), { 'new.json': { provides: 'a Persona' } }).checks.length, 1);
});

test('bullets without a step file are left to the release sweep, and a step file outside a steps command fails', () => {
  assert.deepEqual(stepFileChecks(plan(check({ status: 'auto' }))), { checks: [], problems: [] });
  const manual = check({ stepFile: 'docs/feature-map/steps/x.json', status: 'manual', reason: 'no flujo-drive command', steps: undefined });
  assert.match(stepFileChecks(plan(manual), {}).problems[0], /is not a steps command/);
});

test('checks share a FLUJO when they need the same launch settings, the plain one first', () => {
  const plain = { setup: {} };
  const signed = { setup: { env: { NODE_EXTRA_CA_CERTS: 'ca.pem' } } };
  const signedToo = { setup: { env: { NODE_EXTRA_CA_CERTS: 'ca.pem' } } };
  const groups = instanceGroups([signed, plain, signedToo]);
  assert.deepEqual(groups.map((group) => group.checks.length), [1, 2]);
  assert.deepEqual(groups[0].env, {});
});

test('prints help without starting anything', async () => {
  const lines = [];
  assert.equal(await main(['--help'], (line) => lines.push(line)), 0);
  assert.match(lines.join('\n'), /npm run build/);
  assert.match(lines.join('\n'), /never 4200/);
});
