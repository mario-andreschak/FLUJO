import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';
import { assertRequiredCheckWorkflow } from './required-check-workflow.mjs';
import { assertWorkflowContract } from './workflow-contract.mjs';
const directory = new URL('../.github/workflows/', import.meta.url);
const actual = () => YAML.parse(fs.readFileSync(new URL('verify.yml', directory), 'utf8'));
test('actual single hosted check and manual broad workflow agree', () => {
  assertRequiredCheckWorkflow(actual());
  const files = Object.fromEntries(fs.readdirSync(directory).filter(file => /\.ya?ml$/.test(file)).map(file => [file, YAML.parse(fs.readFileSync(new URL(file, directory), 'utf8'))]));
  assertWorkflowContract(files);
});
for (const [label, mutate] of [
  ['extra hosted job', value => { value.jobs.other = structuredClone(value.jobs.verification); }],
  ['skipped job', value => { value.jobs.verification.if = 'false'; }],
  ['renamed check', value => { value.jobs.verification.name = 'optional'; }],
  ['tolerated failure', value => { value.jobs.verification['continue-on-error'] = true; }],
  ['hidden prerequisite', value => { value.jobs.verification.needs = ['old']; }],
  ['moving runtime', value => { value.jobs.verification.steps[1].with['node-version'] = '24'; }],
  ['omitted build', value => { value.jobs.verification.steps = value.jobs.verification.steps.filter(step => step.run !== 'npm run build'); }],
  ['duplicate install', value => { value.jobs.verification.steps.push({ run: 'npm ci --include=dev' }); }],
  ['removed transfer regression', value => { value.jobs.verification.steps.find(step => step.name?.startsWith('Critical')).run = 'node scripts/run-local-jest.cjs'; }],
  ['filtered PR', value => { value.on.pull_request = { paths: ['src/**'] }; }],
  ['muted failure', value => { value.jobs.verification.steps.find(step => step.run === 'npm run build').run += ' || true'; }],
]) test('reject ' + label, () => { const value = actual(); mutate(value); assert.throws(() => assertRequiredCheckWorkflow(value)); });

test('a second PR workflow is refused even when focused verification passes', () => {
 const files = Object.fromEntries(fs.readdirSync(directory).filter(file => /\.ya?ml$/.test(file)).map(file => [file, YAML.parse(fs.readFileSync(new URL(file, directory), 'utf8'))]));
 files['scorecard-source.yml'].on.pull_request = {};
 assert.throws(() => assertWorkflowContract(files), /Only focused verification/);
});
