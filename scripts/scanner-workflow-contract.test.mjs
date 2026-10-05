import assert from 'node:assert/strict';
import test from 'node:test';
import { assertScannerWorkflowContract } from './scanner-workflow-contract.mjs';

function workflow() {
  return { jobs: { codeql: {
    permissions: { contents: 'read', actions: 'read', 'security-events': 'write' },
    strategy: { 'fail-fast': false, matrix: { language: ['javascript-typescript', 'actions'] } },
    steps: [
      { uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', with: { 'persist-credentials': false } },
      { uses: 'github/codeql-action/init@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2',
        with: { languages: '${{ matrix.language }}', 'build-mode': 'none', queries: 'security-extended' } },
      { uses: 'github/codeql-action/analyze@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2',
        with: { category: '/language:${{ matrix.language }}', upload: 'always', 'skip-queries': 'false', 'wait-for-processing': 'true' } },
    ],
  } } };
}

test('complete two-language extended scans with current-source upload are required', () => {
  assertScannerWorkflowContract(workflow());
});

for (const [label, mutate] of [
  ['missing scanner', value => { delete value.jobs.codeql; }],
  ['conditional initialization', value => { value.jobs.codeql.steps[1].if = 'false'; }],
  ['conditional analysis', value => { value.jobs.codeql.steps[2].if = 'false'; }],
  ['tolerated analysis failure', value => { value.jobs.codeql.steps[2]['continue-on-error'] = true; }],
  ['missing initialization', value => { value.jobs.codeql.steps.splice(1, 1); }],
  ['missing analysis', value => { value.jobs.codeql.steps.pop(); }],
  ['duplicate analysis', value => { value.jobs.codeql.steps.push(structuredClone(value.jobs.codeql.steps[2])); }],
  ['analysis before initialization', value => { value.jobs.codeql.steps.reverse(); }],
  ['removed query suite', value => { delete value.jobs.codeql.steps[1].with.queries; }],
  ['reduced query suite', value => { value.jobs.codeql.steps[1].with.queries = 'security-default'; }],
  ['configuration with file exclusions', value => { value.jobs.codeql.steps[1].with['config-file'] = './filtered-codeql.yml'; }],
  ['missing upload policy', value => { delete value.jobs.codeql.steps[2].with.upload; }],
  ['disabled upload', value => { value.jobs.codeql.steps[2].with.upload = 'never'; }],
  ['failure-only upload', value => { value.jobs.codeql.steps[2].with.upload = 'failure-only'; }],
  ['skipped query execution', value => { value.jobs.codeql.steps[2].with['skip-queries'] = 'true'; }],
  ['no processing wait', value => { value.jobs.codeql.steps[2].with['wait-for-processing'] = 'false'; }],
  ['different result category', value => { value.jobs.codeql.steps[2].with.category = 'other'; }],
  ['different upload revision', value => { value.jobs.codeql.steps[2].with.sha = 'a'.repeat(40); }],
  ['missing result-upload permission', value => { delete value.jobs.codeql.permissions['security-events']; }],
  ['matrix excludes a language', value => { value.jobs.codeql.strategy.matrix.exclude = [{ language: 'actions' }]; }],
  ['language failure cancels the other analysis', value => { value.jobs.codeql.strategy['fail-fast'] = true; }],
  ['mutable CodeQL action', value => { value.jobs.codeql.steps[2].uses = 'github/codeql-action/analyze@v4'; }],
]) {
  test(`scanner contract refuses ${label}`, () => {
    const value = workflow(); mutate(value);
    assert.throws(() => assertScannerWorkflowContract(value), /CodeQL/);
  });
}
