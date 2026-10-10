import { REQUIRED_JOB_IDS, REQUIRED_CHECK_NAMES } from './verification-contract.mjs';
import { assertScannerWorkflowContract } from './scanner-workflow-contract.mjs';

/** Critical local and hosted regressions are retained alongside genuine merge checks. */
export const CRITICAL_TEST_FILES = Object.freeze([
  '__tests__/settings/backupRestoreRoutes.test.ts',
  '__tests__/settings/backupStrictStorage.test.ts',
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
  '__tests__/ollama/ollamaClient.test.ts',
  '__tests__/ollama/pullRoute.test.ts',
  '__tests__/packages/workspaceMcpPreparationMarker.test.ts',
  '__tests__/security/ownerAccess.test.ts',
  '__tests__/security/isolatedMcp.test.ts',
  '__tests__/mcp/isolatedMcpTransport.test.ts',
  '__tests__/mcp/securityReviewSource.test.ts',
  '__tests__/mcp/securityReviewReport.test.ts',
  '__tests__/mcp/securityReviewRoute.test.ts',
  '__tests__/mcp/securityReviewLifecycle.test.ts',
  '__tests__/mcp/securityReviewRunner.test.ts',
  '__tests__/mcp/modelRiskEvidence.test.ts',
  '__tests__/mcp/modelRiskAssessment.test.ts',
  '__tests__/mcp/modelRiskAssessmentRoute.test.ts',
  '__tests__/model/readOnlyAssessmentAdapter.test.ts',
  '__tests__/mcp/discoverySearch.test.ts',
  '__tests__/mcp/registryDiscovery.test.ts',
  '__tests__/mcp/assistedPreferences.test.ts',
  '__tests__/mcp/assistedRanking.test.ts',
  '__tests__/mcp/assistedInstall.test.ts',
  '__tests__/mcp/assistantRoute.test.ts',
  '__tests__/mcp/registryInstall.test.ts',
  '__tests__/mcp/registryIconsRoute.test.ts',
  '__tests__/mcp/registryDiscoveryClient.test.ts',
  '__tests__/mcp/registryDiscoveryRoute.test.ts',
  '__tests__/mcp/registryWorkspaceIsolation.test.ts',
  '__tests__/mcp/quality/orchestrator.test.ts',
  '__tests__/mcp/installBestAssistedTool.test.ts',
  '__tests__/mcp/assistedDiscoveryBody.test.ts',
]);
export const CRITICAL_TEST_COMMAND = 'node scripts/run-local-jest.cjs --ci --selectProjects node --runInBand --runTestsByPath ' + CRITICAL_TEST_FILES.join(' ');
export const CRITICAL_FRONTEND_TEST_FILES = Object.freeze([
  '__tests__/frontend/components/DayViewMiniMonth.test.tsx',
  '__tests__/frontend/components/ChatHistory.test.tsx',
  '__tests__/frontend/components/PersonaGoalCard.test.tsx',
  '__tests__/frontend/components/PersonaGoalValidation.test.tsx',
  '__tests__/frontend/components/BackupSettings.test.tsx',
  '__tests__/frontend/components/ModelConnectionWizard.test.tsx',
  '__tests__/frontend/components/McpConnectionWizard.test.tsx',
  '__tests__/frontend/components/McpAiConnectionPanel.test.tsx',
  '__tests__/frontend/components/McpServerManagerWizardOwnership.test.tsx',
  '__tests__/frontend/components/oauthPopup.test.ts',
  '__tests__/frontend/components/CardPickerGrid.test.tsx',
  '__tests__/frontend/components/PersonaCreationWizard.test.tsx',
  '__tests__/frontend/components/RoleVersionCardLocalization.test.tsx',
  '__tests__/frontend/components/McpSecurityReviewPanel.test.tsx',
  '__tests__/frontend/components/McpModelRiskAssessmentPanel.test.tsx',
  '__tests__/frontend/components/ServerModalDiscoverySession.test.tsx',
  '__tests__/frontend/components/MarketplaceTab.test.tsx',
]);
export const CRITICAL_FRONTEND_TEST_COMMAND = 'node scripts/run-local-jest.cjs --ci --selectProjects jsdom --runInBand --runTestsByPath ' + CRITICAL_FRONTEND_TEST_FILES.join(' ');
export function assertRequiredCheckWorkflow(workflow) {
  const events = workflow?.on ?? {};
  if (JSON.stringify(events.pull_request) !== JSON.stringify({ branches: ['main'] })
      || JSON.stringify(events.push) !== JSON.stringify({ branches: ['main'] })
      || !Object.hasOwn(events, 'workflow_dispatch') || Object.hasOwn(events, 'pull_request_target')) {
    throw new Error('Integration verification must run on all main-target PRs and main pushes, plus explicit dispatch.');
  }
  const expectedJobs = [...REQUIRED_JOB_IDS, 'verification', 'persona-memory-profile'].sort();
  if (JSON.stringify(Object.keys(workflow.jobs ?? {}).sort()) !== JSON.stringify(expectedJobs)) throw new Error('The genuine required jobs cannot be replaced or supplemented by status-only jobs.');
  if (workflow.permissions?.contents !== 'read' || Object.values(workflow.permissions).some(value => !['read', 'none'].includes(value))) throw new Error('Verification defaults must be read-only.');
  const names = REQUIRED_JOB_IDS.flatMap(id => {
    const job = workflow.jobs[id];
    if (!job || job.if !== undefined || job['continue-on-error']) throw new Error('Real prerequisites must run and fail normally.');
    return job.strategy?.matrix?.os ? job.strategy.matrix.os.map(os => job.name.replace('${{ matrix.os }}', os))
      : job.strategy?.matrix?.language ? job.strategy.matrix.language.map(language => job.name.replace('${{ matrix.language }}', language)) : [job.name];
  });
  if (JSON.stringify([...names, workflow.jobs.verification.name]) !== JSON.stringify(REQUIRED_CHECK_NAMES)) throw new Error('Actual job names must match all twelve active required contexts.');
  const gate = workflow.jobs.verification;
  if (gate.name !== 'verification' || gate.if !== 'always()' || gate['continue-on-error']
      || JSON.stringify(gate.needs) !== JSON.stringify(REQUIRED_JOB_IDS)
      || !gate.steps?.some(step => step.run?.includes('assertFullDependencyResults') && step.if === undefined && !step['continue-on-error'])) throw new Error('Verification must fail closed over every real prerequisite.');
  assertScannerWorkflowContract(workflow);
  for (const command of [CRITICAL_TEST_COMMAND, CRITICAL_FRONTEND_TEST_COMMAND]) {
    const matches = workflow.jobs.test.steps.filter(step => step.run === command);
    if (matches.length !== 1 || matches[0].if !== undefined || matches[0]['continue-on-error']) throw new Error('Critical regression commands must run unfiltered and fail normally.');
  }
}
