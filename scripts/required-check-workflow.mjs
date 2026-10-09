/** The hosted contract is deliberately focused; broad coverage remains local/manual. */
export const CRITICAL_TEST_FILES = Object.freeze([
  '__tests__/workspace/workspaceListRoute.test.ts',
  '__tests__/workspace/workspaceCreateMcpRecords.test.ts',
  '__tests__/workspace/workspaceRouteWrapper.test.ts',
  '__tests__/flow/conversationLogReadAdmission.test.ts',
  '__tests__/flow/conversationSnapshotAdmission.test.ts',
  '__tests__/flow/modelTurnArchiveWriteBudget.test.ts',
  '__tests__/mcp/toolDiscoveryPagination.test.ts',
  '__tests__/mcp/storedTransportAdmission.test.ts',
  '__tests__/mcp/tasksGenerationsProtocol.test.ts',
  '__tests__/mcp/clientTasksLifecycle.test.ts',
  '__tests__/mcp/tasksExtensionSession.test.ts',
  '__tests__/mcp/serverTasks.test.ts',
  '__tests__/mcp/flowsTasksServer.test.ts',
  '__tests__/mcp/flowsTasksRouteClassification.test.ts',
  '__tests__/mcp/protectedPackageRunner.test.ts',
  '__tests__/model/orcarouterProvider.test.ts',
  '__tests__/packages/workspaceMcpPreparationMarker.test.ts',
  '__tests__/security/ownerAccess.test.ts',
  '__tests__/security/isolatedMcp.test.ts',
  '__tests__/mcp/isolatedMcpTransport.test.ts',
]);
export const CRITICAL_TEST_COMMAND = 'node scripts/run-local-jest.cjs --ci --selectProjects node --runInBand --runTestsByPath ' + CRITICAL_TEST_FILES.join(' ');
export const CRITICAL_FRONTEND_TEST_FILES = Object.freeze([
  '__tests__/frontend/components/ModelConnectionWizard.test.tsx',
  '__tests__/frontend/components/CardPickerGrid.test.tsx',
  '__tests__/frontend/components/PersonaCreationWizard.test.tsx',
  '__tests__/frontend/components/RoleVersionCardLocalization.test.tsx',
]);
export const CRITICAL_FRONTEND_TEST_COMMAND = 'node scripts/run-local-jest.cjs --ci --selectProjects jsdom --runInBand --runTestsByPath ' + CRITICAL_FRONTEND_TEST_FILES.join(' ');
export function assertRequiredCheckWorkflow(workflow) {
  if (!Object.hasOwn(workflow?.on ?? {}, 'pull_request') || workflow.on.pull_request != null
      || !workflow.on.push?.branches?.includes('main') || workflow.on.push.paths || workflow.on.push['paths-ignore']) {
    throw new Error('Focused verification must run on every pull request and main push.');
  }
  if (JSON.stringify(Object.keys(workflow.jobs ?? {})) !== JSON.stringify(['verification'])) throw new Error('Exactly one hosted verification job is required.');
  const job = workflow.jobs.verification;
  if (job.name !== 'verification' || job['runs-on'] !== 'ubuntu-latest' || job.if !== undefined || job.needs !== undefined
      || job.strategy !== undefined || job['continue-on-error'] !== undefined || job.env?.NODE_OPTIONS || workflow.env?.NODE_OPTIONS
      || job['timeout-minutes'] !== 45) throw new Error('The focused verification job must execute directly and fail normally.');
  if (workflow.permissions?.contents !== 'read' || Object.values(workflow.permissions).some(value => !['read', 'none'].includes(value))) throw new Error('Verification defaults must be read-only.');
  const steps = job.steps ?? [];
  for (const step of steps) {
    if (step.uses && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step.uses)) throw new Error('Actions must be immutable.');
    if (step.run && (step.if !== undefined || step['continue-on-error'] !== undefined || step.env?.NODE_OPTIONS
        || /NODE_OPTIONS=|--max-old-space-size|\|\|\s*true/.test(step.run))) throw new Error('Critical commands cannot skip or tolerate failure.');
  }
  const checkout = steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  if (checkout.length !== 1 || steps[0] !== checkout[0] || checkout[0].with?.['persist-credentials'] !== false || checkout[0].with?.ref) throw new Error('Check the actual event source without persisted credentials.');
  const setups = steps.filter(step => step.uses?.startsWith('actions/setup-node@'));
  if (setups.length !== 1 || setups[0].with?.['node-version'] !== '24.21.0' || setups[0].if !== undefined) throw new Error('Select one supported pinned runtime.');
  const setupIndex = steps.indexOf(setups[0]);
  if (steps[setupIndex + 1]?.run !== 'node scripts/verify-ci-node.mjs 24.21.0 --record'
      || steps.slice(0, setupIndex).some(step => step.run)) throw new Error('Verify official Node before commands.');
  const commands = steps.flatMap(step => (step.run ?? '').split('\n')).filter(Boolean);
  for (const command of ['npm ci --include=dev', 'npm run build', 'npm run typecheck:mcp', 'npm run validate:mcp-release', CRITICAL_TEST_COMMAND, CRITICAL_FRONTEND_TEST_COMMAND]) {
    if (commands.filter(value => value === command).length !== 1) throw new Error('Missing or duplicated critical command: ' + command);
  }
  const install = commands.indexOf('npm ci --include=dev');
  const build = commands.indexOf('npm run build');
  if (install >= build || build >= commands.indexOf('npm run validate:mcp-release') || build >= commands.indexOf(CRITICAL_TEST_COMMAND) || build >= commands.indexOf(CRITICAL_FRONTEND_TEST_COMMAND)) throw new Error('Install, build and test the same artifacts in order.');
  const contracts = steps.find(step => step.name === 'Verify workflow and release contracts')?.run?.split(/\s+/) ?? [];
  for (const file of ['verification-contract', 'workflow-contract', 'required-check-workflow', 'verify-repository-rules', 'verify-ci-node', 'node-runtime', 'scanner-workflow-contract', 'probe-filesystem-identity', 'selector-parser-security', 'require-release-verification', 'release-verification']) {
    if (!contracts.includes('scripts/' + file + '.test.mjs')) throw new Error('Missing contract regression: ' + file);
  }
  if (contracts[0] !== 'node' || contracts[1] !== '--test' || contracts.slice(2).some(file => !/^scripts\/[\w.-]+\.test\.mjs$/.test(file))) throw new Error('Contract tests must execute without filters.');
  if (!steps.some(step => step.uses?.startsWith('actions/upload-artifact@') && step.if === 'always()'
      && !step['continue-on-error'] && step.with?.path === 'ci-node-runtime/' && step.with['if-no-files-found'] === 'error')) throw new Error('Runtime measurement must be retained.');
}
