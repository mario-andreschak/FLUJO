// This unit fixture models an already unlocked workspace; fresh-profile denial
// and real enrollment are covered by the dedicated encryption suites.
jest.mock('@/utils/encryption/secure', () => ({
  ...jest.requireActual('@/utils/encryption/secure'),
  isEncryptionLocked: async () => false,
}));

/** Real FlowSpec -> FlowConverter/Pocketflow -> runFlow -> scheduler history.
 * Only storage and MCP delivery are fixtures; no model or live failing worker
 * is needed to exercise deterministic scheduled output/error semantics. */
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
jest.mock('@/backend/services/mcp', () => ({ mcpService: {
  callTool: jest.fn(), setNodeRoots: jest.fn(),
  loadServerConfigs: jest.fn(async () => [{ name: 'bash' }]),
  listServerTools: jest.fn(async () => ({ tools: [{ name: 'run', inputSchema: { type: 'object' } }] })),
} }));

import { compileFlowSpec } from '@/utils/shared/flowSpecCompiler';
import { SchedulerService } from '@/backend/services/scheduler';
import { mcpService } from '@/backend/services/mcp';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { getFlowRunEventBus, type FlowEvent } from '@/backend/services/scheduler/flowRunEventBus';

function flow(options: { onError?: 'continue' | 'fail'; output?: boolean; resultFormat?: 'text' | 'json' } = {}): Flow {
  return compileFlowSpec({ name: 'Static health fixture', nodes: [
    { key: 'start', type: 'start' },
    { key: 'probe', type: 'static',
      ...(options.output === false ? {} : { outputTemplate: '${var:health}' }),
      entries: [{ kind: 'toolCall', executionMode: 'real', serverName: 'bash', toolName: 'run',
        argumentsJson: '{"command":"harmless fixture"}', result: '', captureVariable: 'health',
        resultFormat: options.resultFormat ?? 'text', onError: options.onError,
      }],
    },
    { key: 'finish', type: 'finish' },
  ], edges: [{ from: 'start', to: 'probe' }, { from: 'probe', to: 'finish' }] }, {
    servers: [{ name: 'bash' }], serverTools: { bash: ['run'] },
  }).flow!;
}

describe('Static-only scheduled flows (#537/#538)', () => {
  let scheduler: SchedulerService;
  let events: FlowEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    store.clear();
    fixtureFlow = flow({ onError: 'fail' });
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
    (mcpService.callTool as jest.Mock).mockReset().mockResolvedValue({ success: true, data: {
      isError: false, content: [{ type: 'text', text: '{"status":"healthy","exitCode":0}' }],
    } });
    scheduler = new SchedulerService();
    events = [];
    unsubscribe = getFlowRunEventBus().subscribe(event => { events.push(event); });
  });

  afterEach(async () => {
    unsubscribe();
    await scheduler.setPaused(true);
    FlowExecutor.conversationStates.clear();
  });

  const scheduledRun = async (saveConversations = false) => {
    const created = await scheduler.create({
      name: 'Probe fixture', flowId: fixtureFlow.id, enabled: true, prompt: 'Run the probe',
      trigger: { type: 'schedule', cron: '0 0 1 1 *' }, saveConversations,
    });
    expect(created.error).toBeUndefined();
    const result = await scheduler.runNow(created.execution!.id);
    expect(result.error).toBeUndefined();
    const retained = store.get(`planned-execution-runs/${created.execution!.id}`) as RunRecord[];
    return { record: result.record!, retained };
  };

  it.each([false, true])('retains the selected successful result with saveConversations=%s', async saveConversations => {
    const { record, retained } = await scheduledRun(saveConversations);
    expect(record).toMatchObject({ status: 'completed', outputText: '{"status":"healthy","exitCode":0}' });
    expect(retained).toEqual([record]);
    expect([...store.keys()].some(key => key.startsWith('conversations/'))).toBe(saveConversations);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      status: 'completed', outputText: record.outputText,
    })]));
    if (!saveConversations) expect(FlowExecutor.conversationStates.has(record.conversationId)).toBe(false);
  });

  it('applies existing scheduler history size limits to captured output', async () => {
    (mcpService.callTool as jest.Mock).mockResolvedValue({ success: true, data: {
      content: [{ type: 'text', text: 'observed-'.repeat(2_000) }],
    } });
    const { record, retained } = await scheduledRun();
    expect(record.outputText).toHaveLength(4097);
    expect(record.outputText!.endsWith('…')).toBe(true);
    expect(retained[0].outputText).toBe(record.outputText);
  });

  it.each([
    [{ success: true, data: { isError: true, content: [{ type: 'text', text: '{"exitCode":2,"status":"retry"}' }] } }, 'exitCode'],
    [{ success: false, error: 'transport unavailable' }, 'transport unavailable'],
    [{ success: false, error: 'request timed out', errorType: 'timeout', statusCode: 408 }, 'request timed out'],
  ])('records authored failures and error terminal events without a saved conversation %#', async (result, reason) => {
    (mcpService.callTool as jest.Mock).mockResolvedValue(result);
    const { record, retained } = await scheduledRun();
    expect(record.status).toBe('error');
    expect(record.error).toContain(reason);
    expect(record.errorDetails?.code).toMatch(/^static_mcp_/);
    expect(retained).toEqual([record]);
    expect([...store.keys()].some(key => key.startsWith('conversations/'))).toBe(false);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'error' })]));
  });

  it('preserves legacy completed/fallback behavior when output and failure policy are omitted', async () => {
    fixtureFlow = flow({ output: false });
    (mcpService.callTool as jest.Mock).mockResolvedValue({ success: true, data: {
      isError: true, content: [{ type: 'text', text: 'recoverable failure' }],
    } });
    const { record } = await scheduledRun();
    expect(record).toMatchObject({ status: 'completed', outputText: 'Processing complete.' });
  });

  it('returns structured failure details and matching run:done errors through the API core', async () => {
    (mcpService.callTool as jest.Mock).mockResolvedValue({ success: false, error: 'server offline' });
    const emitted: unknown[] = [];
    const result = await runFlow({ flowDefinition: fixtureFlow, mode: 'ephemeral', source: 'api',
      prompt: 'Probe', emit: event => { emitted.push(event); },
    });
    expect(result.status).toBe('error');
    expect(result.error?.details).toMatchObject({ type: 'mcp_service_error', code: 'static_mcp_service_error', name: 'run', param: 'bash' });
    expect(emitted).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'run:done', status: 'error', error: expect.objectContaining({ code: 'static_mcp_service_error' }),
    })]));
  });

  it('cancels a real in-flight call and emits an error terminal event without serialized signals', async () => {
    const controller = new AbortController();
    (mcpService.callTool as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      const signal = args[6] as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      controller.abort();
      expect(signal.aborted).toBe(true);
      return { success: false, errorType: 'cancelled', error: 'cancelled by caller' };
    });
    const emitted: unknown[] = [];
    const result = await runFlow({ flowDefinition: fixtureFlow, mode: 'ephemeral', source: 'api',
      prompt: 'Probe', abortSignal: controller.signal, emit: event => { emitted.push(event); },
    });
    expect(result.status).toBe('error');
    expect(result.error?.details?.code).toBe('static_tool_cancelled');
    expect(JSON.stringify(result.sharedState)).not.toContain('abortSignal');
    expect(emitted).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run:done', status: 'error' })]));
  });
});
