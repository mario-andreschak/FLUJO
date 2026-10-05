import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';
import { assertRequiredCheckWorkflow } from './required-check-workflow.mjs';

const actual = () => YAML.parse(fs.readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));

test('the actual verification workflow executes all configured required checks', () => {
  assertRequiredCheckWorkflow(actual());
});

for (const [label, mutate] of [
  ['missing security job', value => { delete value.jobs['dependency-security']; }],
  ['skipped job', value => { value.jobs.typecheck.if = 'false'; }],
  ['renamed required context', value => { value.jobs.typecheck.name = 'optional typecheck'; }],
  ['tolerated failure', value => { value.jobs.codeql['continue-on-error'] = true; }],
  ['missing platform', value => { value.jobs['production-build'].strategy.matrix.os.pop(); }],
  ['missing aggregate dependency', value => { value.jobs.verification.needs.pop(); }],
  ['conditional aggregate', value => { value.jobs.verification.if = 'success()'; }],
  ['production-only audit', value => {
    value.jobs['dependency-security'].steps.find(step => step.run?.startsWith('npm audit')).run = 'npm audit --omit=dev';
  }],
]) {
  test(`reject ${label}`, () => {
    const value = actual();
    mutate(value);
    assert.throws(() => assertRequiredCheckWorkflow(value));
  });
}
