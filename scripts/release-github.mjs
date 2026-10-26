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

const PR_MERGE_TIMEOUT_MS = 3 * 60 * 60_000;
export const releaseBranch = (version) => `release/${version}`;

// Raw diff of exact before/after blob IDs, modes and paths. Two commits with the
// same output introduce exactly the same change, whatever their parents contain.
const exactChange = (git, from, to) => git(['diff', '--raw', '--no-abbrev', '--no-renames', '-z', from, to]);

/**
 * main accepts changes only through pull requests. Land the local version commit
 * through one and return the resulting main commit. Every step is idempotent, so
 * rerunning the release after an interruption resumes the same pull request.
 */
export async function landVersionCommit({ git, gh, version, localSha, baseSha, wait = setTimeout, now = () => Date.now(), timeoutMs = PR_MERGE_TIMEOUT_MS }) {
  if (!VERSION.test(version) || !SHA.test(localSha) || !SHA.test(baseSha)) throw new Error('Invalid version commit identity.');
  const branch = releaseBranch(version);
  const repo = ['--repo', RELEASE_REPOSITORY];
  const find = () => JSON.parse(gh(['pr', 'list', ...repo, '--head', branch, '--base', 'main', '--state', 'all', '--limit', '20',
    '--json', 'number,state,headRefOid,mergeCommit'])).filter((pr) => pr.headRefOid === localSha).sort((a, b) => b.number - a.number)[0];
  let pr = find();
  if (!pr || pr.state === 'CLOSED') {
    // Never force: an unrelated commit on this branch stops the release here.
    git(['push', 'origin', `${localSha}:refs/heads/${branch}`]);
    gh(['pr', 'create', ...repo, '--base', 'main', '--head', branch, '--title', `Release ${version}`, '--body',
      `Version bump only: synchronizes every package and embedded version string to ${version}. Created by \`npm run release\`, which publishes the exact resulting main commit.`]);
    pr = find();
    if (pr?.state !== 'OPEN') throw new Error(`The release pull request for ${branch} did not appear.`);
  }
  if (pr.state === 'OPEN') {
    const merge = ['pr', 'merge', String(pr.number), ...repo, '--squash', '--subject', `Bump version to ${version} (#${pr.number})`];
    try { gh(merge); } catch {
      // Requirements are not met yet: let GitHub merge once they are.
      gh([...merge, '--auto']);
      console.log(`Release pull request #${pr.number} will merge when its requirements pass.`);
    }
  }
  const deadline = now() + timeoutMs;
  for (pr = find(); pr?.state !== 'MERGED'; pr = find()) {
    if (pr?.state !== 'OPEN') throw new Error(`Release pull request for ${branch} was closed without merging.`);
    if (now() >= deadline) throw new Error(`Release pull request #${pr.number} has not merged. Merge it, then rerun npm run release to continue.`);
    await wait(15_000);
  }
  const merged = pr.mergeCommit?.oid;
  if (!SHA.test(merged ?? '')) throw new Error(`Release pull request #${pr.number} has no merge commit.`);
  git(['fetch', 'origin', 'main']);
  const parent = git(['rev-parse', `${merged}^`]);
  if (exactChange(git, parent, merged) !== exactChange(git, baseSha, localSha)) {
    throw new Error(`Main commit ${merged} from #${pr.number} does not introduce exactly the local version change; nothing was published.`);
  }
  try { gh(['api', '--method', 'DELETE', `repos/${RELEASE_REPOSITORY}/git/refs/heads/${branch}`]); } catch { /* cleanup only */ }
  return merged;
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
