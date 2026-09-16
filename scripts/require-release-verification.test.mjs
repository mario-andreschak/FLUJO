import assert from 'node:assert/strict';
import test from 'node:test';
import { requireSuccessfulVerification, selectVerificationRun, validatePublicationContext } from './require-release-verification.mjs';

const revision = 'a'.repeat(40);
const workflowId = 42;
const valid = { databaseId: 100, workflowDatabaseId: workflowId, headSha: revision, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
const context = { repository: 'mario-andreschak/FLUJO', revision, checkout: revision, ref: 'refs/heads/main', publication: 'image', version: '3.45.2' };

test('only official exact-SHA main images or matching version installers can publish', () => {
  validatePublicationContext(context);
  validatePublicationContext({ ...context, publication: 'installer', ref: 'refs/tags/v3.45.2' });
  for (const change of [{ repository: 'attacker/FLUJO' }, { checkout: 'b'.repeat(40) }, { ref: 'refs/heads/feature' }, { publication: 'installer', ref: 'refs/tags/v3.45.1' }, { revision: 'main' }]) {
    assert.throws(() => validatePublicationContext({ ...context, ...change }));
  }
});

test('ignores workflow name collisions, other SHAs, PRs and branches', () => {
  const impostors = [{ workflowDatabaseId: 99 }, { headSha: 'b'.repeat(40) }, { event: 'pull_request' }, { headBranch: 'feature' }]
    .map((change, index) => ({ ...valid, databaseId: 200 + index, ...change }));
  assert.equal(selectVerificationRun([...impostors, valid], revision, workflowId), valid);
});

test('a newer failed verification cannot fall back to an older green run', async () => {
  await assert.rejects(requireSuccessfulVerification({ revision, workflowId,
    listRuns: () => [valid, { ...valid, databaseId: 101, conclusion: 'failure' }],
    watchRun: () => { throw new Error('should not watch completed failure'); },
  }), /publication refused/);
});

test('waits for the exact workflow then independently rechecks its result', async () => {
  let watched = false;
  const id = await requireSuccessfulVerification({ revision, workflowId,
    listRuns: () => [{ ...valid, status: watched ? 'completed' : 'in_progress', conclusion: watched ? 'success' : null }],
    watchRun: (run) => { assert.equal(run, valid.databaseId); watched = true; },
  });
  assert.equal(id, valid.databaseId);
});

test('missing verification fails after bounded discovery without dispatching anything', async () => {
  let reads = 0; let waits = 0;
  await assert.rejects(requireSuccessfulVerification({ revision, workflowId, attempts: 3,
    listRuns: () => { reads++; return []; }, wait: () => { waits++; },
    watchRun: () => { throw new Error('cannot watch nonexistent run'); },
  }), /budget/);
  assert.equal(reads, 3); assert.equal(waits, 2);
});

test('a successful watch cannot authorize stale or failed API evidence', async () => {
  let watched = false;
  await assert.rejects(requireSuccessfulVerification({ revision, workflowId,
    listRuns: () => [{ ...valid, status: watched ? 'completed' : 'in_progress', conclusion: watched ? 'failure' : null }],
    watchRun: () => { watched = true; },
  }), /publication refused/);
});
