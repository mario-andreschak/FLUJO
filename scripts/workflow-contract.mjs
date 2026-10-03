import { REQUIRED_JOB_IDS, REQUIRED_CHECK_NAMES } from './verification-contract.mjs';

export function assertWorkflowContract(workflows) {
  for (const [file, workflow] of Object.entries(workflows)) {
    if (!workflow?.permissions || typeof workflow.permissions !== 'object'
        || Object.values(workflow.permissions).some((value) => value !== 'read' && value !== 'none')) {
      throw new Error(`${file} must declare a read-only workflow permission default.`);
    }
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step.uses)) {
          throw new Error(`${file} has a mutable or unsupported action reference: ${step.uses}`);
        }
      }
    }
  }
  const workflow = workflows['verify.yml'];
  if (!workflow || !Object.hasOwn(workflow.on, 'pull_request')
      || workflow.on.pull_request != null
      || !workflow.on.push?.branches?.includes('main') || workflow.on.push.paths || workflow.on.push['paths-ignore']) {
    throw new Error('Verification must run for every pull request and main push without path filters.');
  }
  for (const id of REQUIRED_JOB_IDS) {
    const job = workflow.jobs[id];
    if (!job || job.if || job['continue-on-error']) throw new Error(`Required job ${id} cannot be conditional or optional.`);
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      if (step.if) throw new Error(`Required command in ${id} cannot be conditional.`);
      if (step['continue-on-error'] && !['npm run test:ci', 'npm run test:isolated'].includes(step.run)) {
        throw new Error(`Unapproved optional command in ${id}.`);
      }
    }
  }
  for (const id of ['production-build', 'release-safety']) {
    if (JSON.stringify(workflow.jobs[id].strategy?.matrix?.os) !== JSON.stringify(['ubuntu-latest', 'windows-latest'])) {
      throw new Error(`${id} must cover Ubuntu and Windows.`);
    }
  }
  const names = [...REQUIRED_JOB_IDS, 'verification'].flatMap((id) => {
    const job = workflow.jobs[id];
    return job.strategy?.matrix?.os
      ? job.strategy.matrix.os.map((os) => job.name.replace('${{ matrix.os }}', os))
      : job.strategy?.matrix?.language
        ? job.strategy.matrix.language.map((language) => job.name.replace('${{ matrix.language }}', language))
        : [job.name];
  });
  if (JSON.stringify(names) !== JSON.stringify(REQUIRED_CHECK_NAMES)) throw new Error('Required check names drifted from the publication contract.');
  const build = workflow.jobs['production-build'].steps;
  for (const command of ['npm run build', 'npm run typecheck:mcp', 'npm run validate:mcp-release', 'npm run smoke:mcp-artifacts']) {
    if (!build.some((step) => step.run?.split('\n').includes(command))) throw new Error(`Production checks omitted ${command}.`);
  }
  for (const [id, stage, report] of [['test', 'ci', 'jest-results.json'], ['test-isolated', 'isolated', 'jest-results-isolated.json']]) {
    const steps = workflow.jobs[id].steps;
    const execute = steps.findIndex((step) => step.run === `npm run test:${stage}`);
    const baseline = steps.findIndex((step) => step.run === `npm run verify:test-baseline -- --stage=${stage} --results=${report}`);
    if (execute < 0 || baseline <= execute || steps[baseline]['continue-on-error']) {
      throw new Error(`${id} must enforce completed assertions and explicit skip accounting after Jest.`);
    }
  }
  const gate = workflow.jobs.verification;
  if (gate?.name !== 'verification' || gate.if !== 'always()'
      || JSON.stringify(gate.needs) !== JSON.stringify(REQUIRED_JOB_IDS)
      || gate['continue-on-error'] || !gate.steps.some((step) => step.run?.includes('assertDependencyResults') && !step.if && !step['continue-on-error'])) {
    throw new Error('The required verification check must evaluate every prerequisite even after failures.');
  }
}
