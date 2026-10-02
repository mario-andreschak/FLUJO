import { setTimeout } from 'node:timers/promises';

export const RELEASE_REPOSITORY = 'mario-andreschak/FLUJO';
export const RELEASE_WORKFLOW = 'publish-npm.yml';
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateReleaseRun(run, workflowId) {
  const match = /^Release FLUJO ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) at ([a-f0-9]{40})$/.exec(run.display_title ?? '');
  if (run.repository?.full_name !== RELEASE_REPOSITORY || run.path !== `.github/workflows/${RELEASE_WORKFLOW}`
      || run.workflow_id !== workflowId || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
      || !SHA.test(run.head_sha ?? '') || !match || match[2] !== run.head_sha
      || !Number.isSafeInteger(run.id) || run.id <= 0) {
    throw new Error('Run is not an official, exact-revision main npm release.');
  }
  return { sha: run.head_sha, version: match[1], runId: run.id };
}

export function readReleaseWorkflow(run) {
  const workflow = JSON.parse(run('gh', ['api', `repos/${RELEASE_REPOSITORY}/actions/workflows/${RELEASE_WORKFLOW}`]));
  if (workflow.path !== `.github/workflows/${RELEASE_WORKFLOW}` || workflow.state !== 'active'
      || !Number.isSafeInteger(workflow.id) || workflow.id <= 0) throw new Error('The official npm release workflow is unavailable. Merge publish-npm.yml before releasing.');
  return workflow;
}

export async function dispatchRelease({ run, sha, version, wait = setTimeout }) {
  if (!SHA.test(sha) || !VERSION.test(version)) throw new Error('Invalid release version or revision.');
  const workflow = readReleaseWorkflow(run);
  const list = () => JSON.parse(run('gh', ['api', `repos/${RELEASE_REPOSITORY}/actions/workflows/${workflow.id}/runs?head_sha=${sha}&event=workflow_dispatch&branch=main&per_page=30`])).workflow_runs;
  const previous = list();
  const title = `Release FLUJO ${version} at ${sha}`;
  const pending = previous.filter((item) => item.display_title === title).sort((a, b) => b.id - a.id)[0];
  if (pending) {
    const identity = validateReleaseRun(pending, workflow.id);
    throw new Error(`This version already has release run ${identity.runId}. Use npm run release -- --resume ${identity.runId}.`);
  }
  const seen = new Set(previous.map((item) => item.id));
  run('gh', ['workflow', 'run', RELEASE_WORKFLOW, '--repo', RELEASE_REPOSITORY, '--ref', 'main',
    '-f', `expected_sha=${sha}`, '-f', `version=${version}`]);
  for (let attempt = 0; attempt < 36; attempt++) {
    const candidate = list().filter((item) => item.display_title === title && !seen.has(item.id)).sort((a, b) => b.id - a.id)[0];
    if (candidate) return validateReleaseRun(candidate, workflow.id);
    await wait(5000);
  }
  throw new Error('npm release dispatch did not appear. Inspect Actions before retrying; do not create another version.');
}

export function resumeRelease({ run, runId, checkoutSha, checkoutVersion }) {
  const workflow = readReleaseWorkflow(run);
  const details = JSON.parse(run('gh', ['api', `repos/${RELEASE_REPOSITORY}/actions/runs/${runId}`]));
  const identity = validateReleaseRun(details, workflow.id);
  if (checkoutSha !== identity.sha || checkoutVersion !== identity.version) throw new Error('The checkout must match the selected release SHA and version to resume.');
  const main = run('gh', ['api', `repos/${RELEASE_REPOSITORY}/git/ref/heads/main`, '--jq', '.object.sha']);
  if (main !== identity.sha) throw new Error('Official main moved away from the selected release.');
  if (details.status === 'completed' && details.conclusion !== 'success') {
    run('gh', ['run', 'rerun', String(identity.runId), '--repo', RELEASE_REPOSITORY, '--failed']);
  }
  return identity;
}

export function watchRelease({ run, identity }) {
  try {
    run('gh', ['run', 'watch', String(identity.runId), '--repo', RELEASE_REPOSITORY, '--exit-status', '--interval', '15'], { stdio: 'inherit', timeout: 6 * 60 * 60_000 });
  } catch (error) {
    throw new Error(`Release ${identity.version} failed or stopped waiting. Resume the same tested artifacts with npm run release -- --resume ${identity.runId}. https://github.com/${RELEASE_REPOSITORY}/actions/runs/${identity.runId}`, { cause: error });
  }
  const details = JSON.parse(run('gh', ['api', `repos/${RELEASE_REPOSITORY}/actions/runs/${identity.runId}`]));
  const confirmed = validateReleaseRun(details, readReleaseWorkflow(run).id);
  if (confirmed.sha !== identity.sha || confirmed.version !== identity.version
      || details.status !== 'completed' || details.conclusion !== 'success') throw new Error('Release did not confirm exact-revision success.');
}
