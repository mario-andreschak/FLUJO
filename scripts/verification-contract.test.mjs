import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIRED_JOB_IDS, REQUIRED_CHECK_NAMES, assertDependencyResults, assertVerificationJobs, assertVerificationAttempt } from './verification-contract.mjs';

const jobs = () => REQUIRED_CHECK_NAMES.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
const needs = () => Object.fromEntries(REQUIRED_JOB_IDS.map((id) => [id, { result: 'success' }]));
const context = { runId: 100, revision: 'a'.repeat(40), workflowId: 42 };
const run = { id: 100, workflow_id: 42, head_sha: context.revision, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 2, path: '.github/workflows/verify.yml' };

test('every real prerequisite must complete successfully', () => {
  assertDependencyResults(needs());
  for (const id of REQUIRED_JOB_IDS) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      assert.throws(() => assertDependencyResults({ ...needs(), [id]: { result } }), /Required verification job/);
    }
  }
  assert.throws(() => assertDependencyResults(null));
});

test('publication requires all twelve successful exact-source checks', () => {
  assertVerificationJobs(jobs());
  for (const name of REQUIRED_CHECK_NAMES) {
    const remaining = jobs().filter((job) => job.name !== name);
    assert.throws(() => assertVerificationJobs(remaining), /publication refused/);
    assert.throws(() => assertVerificationJobs([...jobs(), { name, status: 'completed', conclusion: 'success' }]), /publication refused/);
    for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null]) {
      assert.throws(() => assertVerificationJobs([...remaining, { name, status: 'completed', conclusion }]), /publication refused/);
    }
    assert.throws(() => assertVerificationJobs([...remaining, { name, status: 'in_progress', conclusion: 'success' }]), /publication refused/);
  }
});

test('job evidence must belong to the authoritative source, run and attempt', () => {
  assertVerificationAttempt(run, context);
  for (const change of [
    { id: 101 }, { workflow_id: 99 }, { head_sha: 'b'.repeat(40) },
    { head_branch: 'feature' }, { event: 'pull_request' }, { status: 'in_progress' },
    { conclusion: 'skipped' }, { run_attempt: 0 }, { run_attempt: '2' },
    { path: '.github/workflows/impostor.yml' },
  ]) assert.throws(() => assertVerificationAttempt({ ...run, ...change }, context));
});
