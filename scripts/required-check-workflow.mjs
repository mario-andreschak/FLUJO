import { REQUIRED_JOB_IDS } from './verification-contract.mjs';
import { assertScannerWorkflowContract } from './scanner-workflow-contract.mjs';

const REQUIRED_NAMES = {
  'production-build': 'Production build (${{ matrix.os }})',
  'release-safety': 'Release safety (${{ matrix.os }})',
  typecheck: 'typecheck', lint: 'lint', test: 'test', 'test-isolated': 'test-isolated',
  'workflow-contract': 'workflow-contract', 'dependency-security': 'dependency-security',
  codeql: 'CodeQL (${{ matrix.language }})',
};

/** Validate the configured required checks against the actual current workflow. */
export function assertRequiredCheckWorkflow(workflow) {
  if (!Object.hasOwn(workflow?.on ?? {}, 'pull_request') || !workflow?.on?.push?.branches?.includes('main')) {
    throw new Error('Verification must run on pull requests and main pushes.');
  }
  for (const id of REQUIRED_JOB_IDS) {
    const job = workflow.jobs?.[id];
    if (!job || job.name !== REQUIRED_NAMES[id] || job.if !== undefined || job['continue-on-error'] !== undefined) {
      throw new Error(`Required job ${id} must run and fail normally.`);
    }
  }
  for (const id of ['production-build', 'release-safety']) {
    const job = workflow.jobs[id];
    if (JSON.stringify(job.strategy?.matrix?.os) !== JSON.stringify(['ubuntu-latest', 'windows-latest'])) {
      throw new Error(`${id} must verify both production platforms.`);
    }
  }
  assertScannerWorkflowContract(workflow);
  const aggregate = workflow.jobs.verification;
  if (!aggregate || aggregate.name !== 'verification' || aggregate.if !== 'always()' || aggregate['continue-on-error'] !== undefined
      || !Array.isArray(aggregate.needs)
      || JSON.stringify([...aggregate.needs].sort()) !== JSON.stringify([...REQUIRED_JOB_IDS].sort())
      || !aggregate.steps?.some(step => step.run?.includes('assertDependencyResults'))) {
    throw new Error('The final gate must fail closed over every required job.');
  }
  const audit = workflow.jobs['dependency-security'];
  if (!audit.steps?.some(step => /^npm audit --include=dev --audit-level=high(?: |$)/.test(step.run ?? '')
      && step.if === undefined && step['continue-on-error'] === undefined)) {
    throw new Error('Dependency security must audit the complete installed dependency graph.');
  }
}
