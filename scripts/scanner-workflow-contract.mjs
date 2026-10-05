const LANGUAGES = ['javascript-typescript', 'actions'];
const INIT_INPUTS = {
  languages: '${{ matrix.language }}',
  'build-mode': 'none',
  queries: 'security-extended',
};
const ANALYZE_INPUTS = {
  category: '/language:${{ matrix.language }}',
  upload: 'always',
  'skip-queries': 'false',
  'wait-for-processing': 'true',
};

function sameInputs(actual, expected) {
  return actual && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/** Keep required green job names tied to real, complete CodeQL result uploads. */
export function assertScannerWorkflowContract(workflow) {
  const job = workflow?.jobs?.codeql;
  if (!job || job.if !== undefined || job['continue-on-error'] !== undefined
      || job.strategy?.['fail-fast'] !== false
      || Object.keys(job.strategy?.matrix ?? {}).length !== 1
      || JSON.stringify(job.strategy?.matrix?.language) !== JSON.stringify(LANGUAGES)
      || job.permissions?.contents !== 'read' || job.permissions?.actions !== 'read'
      || job.permissions?.['security-events'] !== 'write') {
    throw new Error('CodeQL must require both complete language analyses and result-upload permissions.');
  }
  const steps = job.steps ?? [];
  const checkouts = steps.flatMap((step, index) => step.uses?.startsWith('actions/checkout@') ? [index] : []);
  const checkout = checkouts[0];
  const init = steps.flatMap((step, index) => step.uses?.startsWith('github/codeql-action/init@') ? [index] : []);
  const analyze = steps.flatMap((step, index) => step.uses?.startsWith('github/codeql-action/analyze@') ? [index] : []);
  if (checkouts.length !== 1 || init.length !== 1 || analyze.length !== 1
      || init[0] <= checkout || analyze[0] <= init[0]) {
    throw new Error('CodeQL must initialize and analyze exactly once after the source checkout.');
  }
  const source = steps[checkout];
  if (!/^actions\/checkout@[a-f0-9]{40}$/.test(source.uses)
      || source.if !== undefined || source['continue-on-error'] !== undefined
      || !sameInputs(source.with, { 'persist-credentials': false })) {
    throw new Error('CodeQL source checkout must be pinned, unconditional and use the current workflow source without overrides.');
  }
  for (const [index, action, inputs] of [[init[0], 'init', INIT_INPUTS], [analyze[0], 'analyze', ANALYZE_INPUTS]]) {
    const step = steps[index];
    if (!new RegExp(`^github/codeql-action/${action}@[a-f0-9]{40}$`).test(step.uses)
        || step.if !== undefined || step['continue-on-error'] !== undefined
        || !sameInputs(step.with, inputs)) {
      throw new Error('CodeQL actions must run unconditionally with extended queries and complete current-source uploads.');
    }
  }
}
