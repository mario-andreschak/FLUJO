import { installPrivateProfileFixture, unlockPrivateFixtureInCurrentWorkspace } from '../utils/privateProfileFixture';
import { installBundledFixtureOwner } from '../mcp/fixtures/bundledFixtureOwner';
import { captureOwnedFixtureDirectory, removeOwnedFixtureDirectory } from '../mcp/fixtures/ownedFixtureDirectory';
let privateFixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
let owner: ReturnType<typeof installBundledFixtureOwner> | undefined;
/** Real FlowSpec/engine/scheduler -> production MCP service -> built Bash stdio
 * server -> harmless OS process. Only app storage/flow/model lookup are fixtures.
 * This fixture completes the real nonzero-process reproduction requested in #538. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Flow } from '@/shared/types/flow';
import type { RunRecord } from '@/shared/types/plannedExecution';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { ensureShippedWorkspacePackages } from '@/backend/services/mcp/shippedWorkspacePackages';
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import { saveConfig } from '@/backend/services/mcp/config';
import { previewBundledHostConsent, approveBundledHostConsent } from '@/backend/services/security/bundledMcpConsent';

const store = new Map<string, unknown>();
let fixtureFlow: Flow;

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  assertSafeCollectionId: jest.fn(),
  loadItem: jest.fn(async (key: string, fallback: unknown) => store.has(key)
    ? JSON.parse(JSON.stringify(store.get(key))) : fallback),
  saveItem: jest.fn(async (key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); }),
  clearItem: jest.fn(async (key: string) => { store.delete(key); }),
}));
jest.mock('@/backend/services/flow', () => ({ flowService: {
  getFlow: jest.fn(async () => fixtureFlow),
  loadFlows: jest.fn(async () => fixtureFlow ? [fixtureFlow] : []),
} }));
jest.mock('@/backend/services/model', () => ({ modelService: {
  loadModels: jest.fn(async () => []), getModel: jest.fn(async () => null),
} }));

import { compileFlowSpec } from '@/utils/shared/flowSpecCompiler';
import { SchedulerService } from '@/backend/services/scheduler';
import { mcpService } from '@/backend/services/mcp';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { getFlowRunEventBus, type FlowEvent } from '@/backend/services/scheduler/flowRunEventBus';

const binary = path.resolve(process.cwd(), 'mcp-servers/bash/dist/index.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-static-real-bash-'));
const scratchOwnership = captureOwnedFixtureDirectory(scratch);
const program = path.join(scratch, 'harmless-probe.cjs');
fs.writeFileSync(program, [
  'const code = Number(process.argv[2]);',
  'console.log(JSON.stringify({status: code ? "retry" : "healthy", code: code ? "PROBE_FAILURE" : "PROBE_SUCCESS"}));',
  'process.stderr.write("harmless stderr is not itself failure\\n");',
  'process.exitCode = code;',
].join('\n'));
const quote = (value: string) => process.platform === 'win32'
  ? "'" + value.replace(/'/g, "''") + "'" : "'" + value.replace(/'/g, "'\\''") + "'";
const command = (code: number) => (process.platform === 'win32' ? '& ' : '')
  + quote(process.execPath) + ' ' + quote(program) + ' ' + code;
let bashConfig: MCPStdioConfig;

function flow(code: number, policy?: 'continue' | 'fail', output = true): Flow {
  const compiled = compileFlowSpec({ name: 'Real Bash Static probe', nodes: [
    { key: 'start', type: 'start' },
    { key: 'probe', type: 'static', ...(output ? { outputTemplate: '${var:health}' } : {}),
      entries: [{ kind: 'toolCall', executionMode: 'real', serverName: 'bash', toolName: 'run',
        argumentsJson: JSON.stringify({ command: command(code), cwd: scratch, timeout: 10 }),
        result: '', captureVariable: 'health', resultFormat: 'text', onError: policy,
      }],
    },
    { key: 'finish', type: 'finish' },
  ], edges: [{ from: 'start', to: 'probe' }, { from: 'probe', to: 'finish' }] }, {
    servers: [{ name: 'bash' }], serverTools: { bash: ['run'] },
  });
  expect(compiled.flow).toBeDefined();
  expect(compiled.errorCount).toBe(0);
  return compiled.flow!;
}

describe('Real Bash Static scheduled process result (#537/#538)', () => {
  let scheduler: SchedulerService;
  let events: FlowEvent[];
  let unsubscribe: (() => void) | undefined;
  let toolCall: jest.SpyInstance | undefined;
  let expectedErrors: jest.SpyInstance | undefined;
  let preparation: Promise<void> | undefined;
  let preparationSettled = true;
  let cleanupUncertain = false;
  let firstCase = true;
  let reviewedBashDigest: string;
  const preparationEpoch = performance.now();
  let diagnosticCount = 0;
  const diagnostic = (value: Record<string, unknown>) => {
    try { if (diagnosticCount++ < 128) console.info(JSON.stringify(value)); }
    catch { /* Diagnostic failures cannot replace actual setup or cleanup. */ }
  };
  const phase = (stage: 'private-profile-enter' | 'private-profile-ready' | 'provisioning-enter' | 'provisioning-ready' | 'config-enter' | 'config-ready' | 'preview-enter' | 'preview-ready' | 'grant-enter' | 'grant-ready' | 'connection-enter' | 'connection-ready'
    | 'case-setup-enter' | 'case-setup-ready' | 'disconnect-enter' | 'disconnect-ready' | 'owner-cleanup-enter' | 'owner-cleanup-ready'
    | 'unlock-enter' | 'unlock-ready' | 'cache-reset-enter' | 'cache-reset-ready' | 'scheduler-create-enter' | 'scheduler-create-ready'
    | 'case-settlement-enter' | 'case-settlement-ready') => {
    diagnostic({ shippedFixture: 'real-bash', stage, elapsedMs: performance.now() - preparationEpoch });
  };
  let priorConsentTrace: string | undefined;

  async function approveBash() {
    const approvalStarted = performance.now();
    owner = installBundledFixtureOwner();
    // The same reviewed proposal may be approved again; the protected writer
    // still rechecks the full current proposal and its final publication fence.
    if (reviewedBashDigest === undefined) {
      phase('preview-enter');
      reviewedBashDigest = (await previewBundledHostConsent('bash', { runtimeHome: 'host' })).policyDigest;
      phase('preview-ready');
    }
    phase('grant-enter');
    bashConfig = (await approveBundledHostConsent(owner.request('bash'), 'bash', {
      runtimeHome: 'host', reviewedDigest: reviewedBashDigest, expiresAt: owner.expiresAt,
    })).config;
    phase('grant-ready');
    diagnostic({ bashFixturePhase: 'protected-approval', elapsedMs: performance.now() - approvalStarted });
  }

  beforeAll(() => {
    preparationSettled = false;
    preparation = (async () => {
    priorConsentTrace = process.env.FLUJO_BUNDLED_CONSENT_TRACE;
    process.env.FLUJO_BUNDLED_CONSENT_TRACE = '1';
    expect(fs.existsSync(binary)).toBe(true); // CI builds MCP packages before Jest.
    phase('private-profile-enter');
    privateFixture = await installPrivateProfileFixture(metadata => { store.set('encryption_key', metadata); });
    phase('private-profile-ready');
    phase('provisioning-enter');
    await ensureShippedWorkspacePackages(getWorkspaceDataDir(), undefined, ['bash']);
    phase('provisioning-ready');
    const config: MCPStdioConfig = { ...createShippedServerConfig(SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'bash')!),
      name: 'bash', disabled: false, roots: [scratch], env: { FLUJO_BASH_ROOTS: scratch, FLUJO_FS_ROOTS: scratch } };
    phase('config-enter');
    expect((await saveConfig(new Map([['bash', config]]))).success).toBe(true);
    phase('config-ready');
    await approveBash();
    phase('connection-enter');
    const connected = await mcpService.connectServer('bash');
    phase('connection-ready');
    expect(connected).toMatchObject({ success: true });
    })().finally(() => { preparationSettled = true; });
    return preparation;
  }, 60_000);

  beforeEach(() => {
    if (!preparationSettled || cleanupUncertain) throw new Error('Prior real-Bash setup/cleanup unresolved; refusing another case');
    preparationSettled = false;
    preparation = (async () => {
    phase('case-setup-enter');
    const preparationStarted = performance.now();
    process.env.FLUJO_DATA_DIR = privateFixture.root;
    delete process.env.FLUJO_PARENT_DATA_DIR;
    if (!firstCase) {
      const disconnectStarted = performance.now();
      phase('disconnect-enter');
      expect(await mcpService.disconnectServer('bash')).toMatchObject({ success: true, shutdownReceipt: {
        processOwnership: 'owned', exitOutcome: 'observed_exit', errorClassification: 'none',
      } });
      expect(mcpService.getClient('bash')).toBeUndefined();
      phase('disconnect-ready');
      phase('owner-cleanup-enter');
      owner!.restore();
      owner = undefined;
      phase('owner-cleanup-ready');
      diagnostic({ bashFixturePhase: 'disconnect-and-owner-cleanup', elapsedMs: performance.now() - disconnectStarted });
    }
    store.clear();
    const unlockStarted = performance.now();
    phase('unlock-enter');
    await unlockPrivateFixtureInCurrentWorkspace(metadata => { store.set('encryption_key', metadata); });
    phase('unlock-ready');
    diagnostic({ bashFixturePhase: 'unlock', elapsedMs: performance.now() - unlockStarted });
    store.set('mcp_servers', { bash: bashConfig });
    if (!firstCase) await approveBash();
    firstCase = false;
    expect(Date.now()).toBeLessThan(owner!.expiresAt);
    diagnostic({ bashFixtureGrantRemainingMs: owner!.expiresAt - Date.now(),
      bashFixturePreparationMs: performance.now() - preparationStarted });
    phase('cache-reset-enter');
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
    phase('cache-reset-ready');
    phase('scheduler-create-enter');
    scheduler = new SchedulerService();
    phase('scheduler-create-ready');
    events = [];
    unsubscribe = getFlowRunEventBus().subscribe(event => { events.push(event); });
    // Observe the production method without replacing delivery or protocol data.
    toolCall = jest.spyOn(mcpService, 'callTool');
    expectedErrors = jest.spyOn(console, 'error').mockImplementation(() => {});
    phase('case-setup-ready');
    })().finally(() => { preparationSettled = true; });
    return preparation;
  });

  afterEach(async () => {
    cleanupUncertain = true; // A hook timeout cannot permit another case launch.
    phase('case-settlement-enter');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failures: unknown[] = [];
    try {
      // Below the existing 15s hook deadline. Timeout does not cancel actual
      // setup or permit deleting its equipment/starting another case.
      await Promise.race([preparation?.catch(() => {}), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Actual real-Bash setup remains unsettled')), 14_000);
      })]);
      if (!preparationSettled) throw new Error('Actual real-Bash setup remains unsettled');
      try { toolCall?.mockRestore(); toolCall = undefined; } catch (error) { failures.push(error); }
      try { expectedErrors?.mockRestore(); expectedErrors = undefined; } catch (error) { failures.push(error); }
      try { unsubscribe?.(); unsubscribe = undefined; } catch (error) { failures.push(error); }
      try { if (scheduler) await scheduler.setPaused(true); } catch (error) { failures.push(error); }
      FlowExecutor.conversationStates.clear();
      if (failures.length) throw new AggregateError(failures, 'Real-Bash case cleanup failed');
      cleanupUncertain = false;
      phase('case-settlement-ready');
    } catch (error) { cleanupUncertain = true; throw error; }
    finally { if (timer) clearTimeout(timer); }
  });
  afterAll(async () => {
    if (!preparationSettled || cleanupUncertain) {
      // Restore the operator environment independently but preserve equipment
      // and profile roots while actual setup/cleanup can still use them.
      owner?.restoreEnvironment();
      privateFixture?.restoreEnvironment();
      if (priorConsentTrace === undefined) delete process.env.FLUJO_BUNDLED_CONSENT_TRACE;
      else process.env.FLUJO_BUNDLED_CONSENT_TRACE = priorConsentTrace;
      throw new Error('Real-Bash setup/cleanup unresolved; owned fixture roots preserved');
    }
    const failures: unknown[] = [];
    let actualExit = false;
    try {
      if (privateFixture) process.env.FLUJO_DATA_DIR = privateFixture.root;
      delete process.env.FLUJO_PARENT_DATA_DIR;
      const disconnected = await mcpService.disconnectServer('bash');
      expect(disconnected).toMatchObject({ success: true, shutdownReceipt: {
        processOwnership: 'owned', exitOutcome: 'observed_exit', errorClassification: 'none',
      } });
      expect(mcpService.getClient('bash')).toBeUndefined();
      actualExit = true;
    } catch (error) { failures.push(error); }
    try { owner?.restoreEnvironment(); } catch (error) { failures.push(error); }
    try { privateFixture?.restoreEnvironment(); } catch (error) { failures.push(error); }
    try {
      if (actualExit) {
        try { owner?.removeDirectory(); } catch (error) { failures.push(error); }
        try { await privateFixture?.restore(); } catch (error) { failures.push(error); }
        try { removeOwnedFixtureDirectory(scratchOwnership, path.dirname(scratch), 'flujo-static-real-bash-'); }
        catch (error) { failures.push(error); }
      } else {
        failures.push(new Error('Actual owned Bash exit unresolved; owner/profile/scratch roots preserved'));
      }
    } finally {
      if (priorConsentTrace === undefined) delete process.env.FLUJO_BUNDLED_CONSENT_TRACE;
      else process.env.FLUJO_BUNDLED_CONSENT_TRACE = priorConsentTrace;
    }
    if (failures.length) throw new AggregateError(failures, 'Real-Bash suite retirement failed');
  });

  function executedRunIndex() {
    const indices = toolCall!.mock.calls.flatMap((args, index) => args[0] === 'bash' && args[1] === 'run' ? [index] : []);
    expect(indices).toHaveLength(1); // release_owner is a separate, expected cleanup call.
    expect(toolCall!.mock.calls.some(args => args[0] === 'bash' && args[1] === 'release_owner')).toBe(true);
    return indices[0];
  }

  async function scheduledRun() {
    const created = await scheduler.create({
      name: 'Real Bash probe', flowId: fixtureFlow.id, enabled: true, prompt: 'Run isolated probe',
      trigger: { type: 'schedule', cron: '0 0 1 1 *' }, saveConversations: false,
    });
    expect(created.error).toBeUndefined();
    const result = await scheduler.runNow(created.execution!.id);
    expect(result.error).toBeUndefined();
    const record = result.record!;
    const retained = store.get('planned-execution-runs/' + created.execution!.id) as RunRecord[];
    expect(retained).toEqual([record]);
    expect([...store.keys()].some(key => key.startsWith('conversations/'))).toBe(false);
    const delivered = await toolCall!.mock.results[executedRunIndex()].value;
    expect(delivered.success).toBe(true); // Real MCP delivery remains success even on exit 2.
    const envelope = JSON.parse(delivered.data.content.find((entry: { type: string }) => entry.type === 'text').text);
    return { record, delivered, envelope };
  }

  it('exit 0 in fail mode completes with captured output, ephemeral history and a completed event', async () => {
    fixtureFlow = flow(0, 'fail');
    const { record, delivered, envelope } = await scheduledRun();
    expect(envelope.exitCode).toBe(0);
    expect(delivered.data.isError).not.toBe(true); // MCP isError is optional on success.
    expect(envelope.output).toContain('PROBE_SUCCESS');
    expect(envelope.output).toContain('harmless stderr');
    expect(record.status).toBe('completed');
    expect(record.outputText).toContain('PROBE_SUCCESS');
    expect(record.outputText).not.toBe('Processing complete.');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'completed', outputText: record.outputText })]));
  }, 60_000);

  it('exit 2 in fail mode records a structured error in ephemeral history and terminal events', async () => {
    fixtureFlow = flow(2, 'fail');
    const { record, delivered, envelope } = await scheduledRun();
    expect(envelope.exitCode).toBe(2);
    expect(delivered.data.isError).toBe(true);
    expect(envelope.output).toContain('PROBE_FAILURE');
    expect(record.status).toBe('error');
    expect(record.error).toContain('PROBE_FAILURE');
    expect(record.errorDetails).toMatchObject({ code: 'static_mcp_tool_error', type: 'mcp_tool_error' });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'error' })]));
    expect(events.some(event => 'status' in event && event.status === 'completed')).toBe(false);
  }, 60_000);

  it('exit 2 produces an error flow result and run:done error without following normal Finish', async () => {
    fixtureFlow = flow(2, 'fail');
    const emitted: unknown[] = [];
    const result = await runFlow({ flowDefinition: fixtureFlow, mode: 'ephemeral', source: 'api',
      prompt: 'Run isolated probe', emit: event => { emitted.push(event); },
    });
    expect(result.status).toBe('error');
    expect(result.error?.details).toMatchObject({ type: 'mcp_tool_error', code: 'static_mcp_tool_error' });
    expect(result.error?.message).toContain('PROBE_FAILURE');
    expect(emitted).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run:done', status: 'error', error: expect.objectContaining({ code: 'static_mcp_tool_error' }) })]));
    executedRunIndex();
  }, 60_000);

  it('exit 2 in continue mode preserves completed fallback and inspectable tool context', async () => {
    fixtureFlow = flow(2, 'continue', false);
    const emitted: unknown[] = [];
    const result = await runFlow({ flowDefinition: fixtureFlow, mode: 'ephemeral', source: 'api',
      prompt: 'Run isolated probe', emit: event => { emitted.push(event); },
    });
    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('Processing complete.');
    const toolMessage = result.sharedState.messages.find(message => message.role === 'tool');
    expect(toolMessage?.content).toContain('PROBE_FAILURE');
    expect(toolMessage?.content).toContain('"isError":true');
    expect(emitted).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run:done', status: 'completed' })]));
    executedRunIndex();
  }, 60_000);
});
