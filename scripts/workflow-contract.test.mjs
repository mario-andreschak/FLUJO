import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';
import { assertWorkflowContract } from './workflow-contract.mjs';

const directory = new URL('../.github/workflows/', import.meta.url);
const readWorkflows = () => Object.fromEntries(readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))
  .map((file) => [file, YAML.parse(readFileSync(new URL(file, directory), 'utf8'))]));

test('repository workflows retain mandatory verification and immutable direct action dependencies', () => {
  assertWorkflowContract(readWorkflows());
});

for (const [label, change] of [
  ['mutable action', (files) => { files['verify.yml'].jobs.typecheck.steps[0].uses = 'actions/checkout@main'; }],
  ['persisted checkout credentials', (files) => { files['verify.yml'].jobs.typecheck.steps[0].with['persist-credentials'] = true; }],
  ['broad default token', (files) => { files['verify.yml'].permissions.contents = 'write'; }],
  ['missing permission default', (files) => { delete files['verify.yml'].permissions; }],
  ['path-filtered PR', (files) => { files['verify.yml'].on.pull_request = { paths: ['src/**'] }; }],
  ['missing Windows', (files) => { files['verify.yml'].jobs['production-build'].strategy.matrix.os.pop(); }],
  ['optional matrix', (files) => { files['verify.yml'].jobs['production-build']['continue-on-error'] = true; }],
  ['conditional tests', (files) => { files['verify.yml'].jobs.test.if = 'false'; }],
  ['omitted packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps = files['verify.yml'].jobs['production-build'].steps.filter((step) => step.run !== 'npm run smoke:mcp-artifacts'); }],
  ['skipped packed smoke', (files) => { files['verify.yml'].jobs['production-build'].steps.find((step) => step.run === 'npm run smoke:mcp-artifacts').if = 'false'; }],
  ['optional assertion baseline', (files) => { files['verify.yml'].jobs.test.steps.find((step) => step.run?.startsWith('npm run verify:test-baseline'))['continue-on-error'] = true; }],
  ['omitted final dependency', (files) => { files['verify.yml'].jobs.verification.needs.pop(); }],
  ['conditionally skipped final gate', (files) => { delete files['verify.yml'].jobs.verification.if; }],
]) {
  test(`workflow validation refuses ${label}`, () => {
    const files = readWorkflows();
    change(files);
    assert.throws(() => assertWorkflowContract(files));
  });
}

// Disposable gate fixture; never integrate this intentional failure into main.
test('intentional merge-denial probe', () => assert.fail('expected red gate'));
