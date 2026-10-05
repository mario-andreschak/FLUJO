import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertExportRoute({ eventName, event, repository, workflowSha, proposalSha, runAttempt }) {
  const expectedRepository = 'mario-andreschak/FLUJO';
  assert.equal(repository, expectedRepository);
  assert.equal(eventName, 'pull_request');
  assert.equal(event.action, 'ready_for_review', 'Only the separately selected ready-for-review event may export.');
  assert.equal(event.pull_request.draft, false, 'Draft publication cannot enter export.');
  assert.equal(event.pull_request.head.repo.full_name, expectedRepository, 'Fork export refused.');
  assert.equal(event.pull_request.base.repo.full_name, expectedRepository);
  assert.equal(event.pull_request.head.ref, 'codex/worker-payload-compiled-routes-8800');
  assert.equal(event.pull_request.base.ref, 'codex/scorecard-integration');
  assert.equal(event.pull_request.head.sha, proposalSha);
  assert.match(proposalSha, /^[a-f0-9]{40}$/); assert.match(workflowSha, /^[a-f0-9]{40}$/);
  assert.equal(runAttempt, '1', 'Reruns require a separately reviewed successor route.');
  return { eventName, action: event.action, repository, proposalSha, workflowSha, runAttempt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assertExportRoute({ eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
      repository: process.env.GITHUB_REPOSITORY, workflowSha: process.env.WORKFLOW_SHA,
      proposalSha: process.env.PROPOSAL_SHA, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
