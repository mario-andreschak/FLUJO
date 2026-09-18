import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'mario-andreschak/FLUJO';
const WORKFLOW_PATH = '.github/workflows/verify.yml';

export function validatePublicationContext({ repository, revision, checkout, ref, publication, version }) {
  if (repository?.toLowerCase() !== REPOSITORY.toLowerCase()) throw new Error('Publication is restricted to the official FLUJO repository.');
  if (!/^[a-f0-9]{40}$/.test(revision || '') || checkout !== revision) throw new Error('Publication checkout must match the exact GitHub commit.');
  if (publication === 'image' && ref === 'refs/heads/main') return;
  if (publication === 'installer' && /^\d+\.\d+\.\d+$/.test(version || '') && ref === `refs/tags/v${version}`) return;
  throw new Error('Publication ref is not the expected main branch or matching release tag.');
}

export function selectVerificationRun(runs, revision, workflowId) {
  if (!Array.isArray(runs)) throw new Error('Invalid verification run response.');
  return runs.filter((run) => run.headSha === revision && run.headBranch === 'main'
    && run.event === 'push' && run.workflowDatabaseId === workflowId
    && Number.isSafeInteger(run.databaseId) && run.databaseId > 0)
    .sort((left, right) => right.databaseId - left.databaseId)[0];
}

export async function requireSuccessfulVerification({ revision, workflowId, listRuns, watchRun, wait = setTimeout, attempts = 12 }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const run = selectVerificationRun(await listRuns(), revision, workflowId);
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Exact-commit verification ${run.databaseId} concluded ${run.conclusion}; publication refused.`);
      return run.databaseId;
    }
    if (run && ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)) {
      await watchRun(run.databaseId);
      // Re-read the API after watch: never trust an old success, a mocked title,
      // an unrelated check name, or a newer failed run for this same revision.
    } else if (run) {
      throw new Error(`Unsupported verification status ${run.status}.`);
    } else if (attempt + 1 < attempts) {
      await wait(5000);
    }
  }
  throw new Error('No successful exact-commit verification appeared within the publication gate budget.');
}

async function main() {
  const publication = process.argv[2];
  const revision = process.env.GITHUB_SHA;
  const exec = (command, args, options = {}) => {
    const output = execFileSync(command, args, {
      encoding: 'utf8', windowsHide: true, timeout: 30_000, ...options,
    });
    return typeof output === 'string' ? output.trim() : '';
  };
  validatePublicationContext({
    repository: process.env.GITHUB_REPOSITORY, revision,
    checkout: exec('git', ['rev-parse', 'HEAD']), ref: process.env.GITHUB_REF,
    publication, version: JSON.parse(readFileSync('package.json', 'utf8')).version,
  });
  const workflow = JSON.parse(exec('gh', ['api', `repos/${REPOSITORY}/actions/workflows/verify.yml`]));
  if (workflow.path !== WORKFLOW_PATH || !Number.isSafeInteger(workflow.id) || workflow.state !== 'active') {
    throw new Error('The authoritative verification workflow could not be identified.');
  }
  const deadline = Date.now() + 120 * 60 * 1000;
  const runId = await requireSuccessfulVerification({
    revision, workflowId: workflow.id,
    listRuns: () => JSON.parse(exec('gh', ['run', 'list', '--repo', REPOSITORY,
      '--workflow', String(workflow.id), '--commit', revision, '--branch', 'main', '--event', 'push', '--limit', '10',
      '--json', 'databaseId,workflowDatabaseId,headSha,headBranch,event,status,conclusion'])),
    watchRun: (id) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Verification wait exceeded two hours.');
      exec('gh', ['run', 'watch', String(id), '--repo', REPOSITORY, '--exit-status', '--interval', '15'], { timeout: remaining, stdio: 'inherit' });
    },
  });
  console.log(`Verified ${revision}: https://github.com/${REPOSITORY}/actions/runs/${runId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Publication refused: ${error.message}`); process.exitCode = 1; });
}
