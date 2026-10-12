import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';
import { assertRequiredCheckWorkflow } from './required-check-workflow.mjs';
import { assertWorkflowContract } from './workflow-contract.mjs';
const directory = new URL('../.github/workflows/', import.meta.url);
const actual = () => YAML.parse(fs.readFileSync(new URL('verify.yml', directory), 'utf8'));
test('genuine main integration checks and manual broad workflow agree', () => {
  assertRequiredCheckWorkflow(actual());
  const files = Object.fromEntries(fs.readdirSync(directory).filter(file => /\.ya?ml$/.test(file)).map(file => [file, YAML.parse(fs.readFileSync(new URL(file, directory), 'utf8'))]));
  assertWorkflowContract(files);
});
for (const [label, mutate] of [
  ['extra status-only job', value => { value.jobs.other = structuredClone(value.jobs.verification); }],
  ['skipped prerequisite', value => { value.jobs.test.if = 'false'; }],
  ['renamed check', value => { value.jobs.verification.name = 'optional'; }],
  ['tolerated failure', value => { value.jobs.verification['continue-on-error'] = true; }],
  ['omitted prerequisite', value => { value.jobs.verification.needs.pop(); }],
  ['status-only aggregate', value => { value.jobs.verification.steps.at(-1).run = 'echo success'; }],
  ['removed backend regression', value => { value.jobs.test.steps.find(step => step.name === 'Critical backend regressions').run = 'node scripts/run-local-jest.cjs'; }],
  ['omitted frontend regression', value => { value.jobs.test.steps = value.jobs.test.steps.filter(step => step.name !== 'Critical frontend regressions'); }],
  ['optional critical regressions', value => { value.jobs.test.steps.find(step => step.name === 'Critical frontend regressions')['continue-on-error'] = true; }],
  ['no real scanner', value => { value.jobs.codeql.steps.pop(); }],
  ['filtered PR', value => { value.on.pull_request = { paths: ['src/**'] }; }],
  ['unrelated PR base', value => { value.on.pull_request.branches = ['feature']; }],
  ['intermediate PRs', value => { value.on.pull_request = null; }],
  ['filtered main push', value => { value.on.push.paths = ['src/**']; }],
]) test('reject ' + label, () => { const value = actual(); mutate(value); assert.throws(() => assertRequiredCheckWorkflow(value)); });

test('a second PR workflow is refused even when integration verification passes', () => {
 const files = Object.fromEntries(fs.readdirSync(directory).filter(file => /\.ya?ml$/.test(file)).map(file => [file, YAML.parse(fs.readFileSync(new URL(file, directory), 'utf8'))]));
 files['scorecard-source.yml'].on.pull_request = {};
 assert.throws(() => assertWorkflowContract(files), /Only main integration verification/);
});
