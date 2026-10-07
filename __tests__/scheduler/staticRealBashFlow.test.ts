import { installPrivateProfileFixture } from '../utils/privateProfileFixture';
let privateFixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
afterEach(async () => { await privateFixture?.restore(); });
/** Real FlowSpec/engine/scheduler -> production MCP service -> built Bash stdio
 * server -> harmless OS process. Only app storage/flow/model lookup are fixtures.
 * This fixture completes the real nonzero-process reproduction requested in #538. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Flow } from '@/shared/types/flow';
import type { RunRecord } from '@/shared/types/plannedExecution';

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
const bashConfig = {
  name: 'bash', transport: 'stdio', command: process.execPath, args: [binary],
  cwd: scratch, rootPath: scratch, disabled: false, source: { type: 'local' },
  env: { FLUJO_BASH_ROOTS: scratch, FLUJO_FS_ROOTS: scratch },
};

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
  let unsubscribe: () => void;
  let toolCall: jest.SpyInstance;
  let expectedErrors: jest.SpyInstance;

  beforeAll(async () => {
    expect(fs.existsSync(binary)).toBe(true); // CI builds MCP packages before Jest.
    store.set('mcp_servers', { bash: bashConfig });
    const connected = await mcpService.connectServer('bash');
    expect(connected).toMatchObject({ success: true });
  }, 60_000);

  beforeEach(async () => {
    store.clear();
    privateFixture = await installPrivateProfileFixture(metadata => { store.set('encryption_key', metadata); });
    store.set('mcp_servers', { bash: bashConfig });
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
    scheduler = new SchedulerService();
    events = [];
    unsubscribe = getFlowRunEventBus().subscribe(event => { events.push(event); });
    // Observe the production method without replacing delivery or protocol data.
    toolCall = jest.spyOn(mcpService, 'callTool');
    expectedErrors = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    toolCall.mockRestore();
    expectedErrors.mockRestore();
    unsubscribe();
    await scheduler.setPaused(true);
    FlowExecutor.conversationStates.clear();
  });
  afterAll(async () => {
    try {
      expect(await mcpService.disconnectServer('bash')).toMatchObject({ success: true });
      expect(mcpService.getClient('bash')).toBeUndefined();
    } finally {
      const resolved = path.resolve(scratch);
      expect(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
      expect(path.basename(resolved).startsWith('flujo-static-real-bash-')).toBe(true);
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  function executedRunIndex() {
    const indices = toolCall.mock.calls.flatMap((args, index) => args[0] === 'bash' && args[1] === 'run' ? [index] : []);
    expect(indices).toHaveLength(1); // release_owner is a separate, expected cleanup call.
    expect(toolCall.mock.calls.some(args => args[0] === 'bash' && args[1] === 'release_owner')).toBe(true);
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
    const delivered = await toolCall.mock.results[executedRunIndex()].value;
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
