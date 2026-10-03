/** Shared by CI, release publication, and the administrator acceptance recipe. */
export const REQUIRED_JOB_IDS = Object.freeze([
  'production-build', 'release-safety', 'typecheck', 'lint', 'test',
  'test-isolated', 'workflow-contract', 'dependency-security', 'codeql',
]);

export const REQUIRED_CHECK_NAMES = Object.freeze([
  'Production build (ubuntu-latest)', 'Production build (windows-latest)',
  'Release safety (ubuntu-latest)', 'Release safety (windows-latest)',
  'typecheck', 'lint', 'test', 'test-isolated', 'workflow-contract',
  'dependency-security', 'CodeQL (javascript-typescript)', 'CodeQL (actions)', 'verification',
]);

export function assertDependencyResults(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) throw new Error('Missing verification dependencies.');
  for (const id of REQUIRED_JOB_IDS) {
    if (needs[id]?.result !== 'success') {
      throw new Error(`Required verification job ${id} concluded ${needs[id]?.result ?? 'missing'}.`);
    }
  }
}

/** A green aggregate workflow can still contain skipped or removed jobs. */
export function assertVerificationJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error('Invalid verification jobs response.');
  for (const name of REQUIRED_CHECK_NAMES) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      throw new Error(`Required verification check ${name} is missing, duplicated, unfinished, or unsuccessful; publication refused.`);
    }
  }
}

export function assertVerificationAttempt(run, { revision, workflowId, runId }) {
  if (run?.id !== runId || run.workflow_id !== workflowId || run.head_sha !== revision
      || run.head_branch !== 'main' || run.event !== 'push' || run.status !== 'completed'
      || run.conclusion !== 'success' || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || run.path !== '.github/workflows/verify.yml') {
    throw new Error('Verification attempt does not identify successful exact-commit main verification.');
  }
}
