/**
 * ModelHandler.processToolCalls concurrent execution (issue #252).
 *
 * A turn's tool calls now run CONCURRENTLY under a bounded, per-server
 * configurable cap (MCPManagerConfig.maxConcurrency) instead of one-at-a-time.
 * These tests pin down the invariants the issue cares about:
 *   - result/emit ordering follows the model's original call order, never
 *     completion order (keeps the prefix-cache fingerprint stable);
 *   - a single-call turn stays byte-identical to the old sequential path;
 *   - independent calls really do overlap (peak in-flight > 1);
 *   - each server's peak in-flight respects its own cap;
 *   - Stop mid-batch still yields a well-formed transcript (every id answered);
 *   - the AbortSignal is still forwarded into mcpService.callTool.
 */

const callToolMock = jest.fn();
const loadServerConfigsMock = jest.fn();
const writeRunResourceMock = jest.fn();
const getRunResourceSettingsMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: (...args: unknown[]) => callToolMock(...args),
    loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
  },
}));
jest.mock('@/backend/services/runResources', () => {
  const actual = jest.requireActual('@/backend/services/runResources');
  return {
    ...actual,
    writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
    getRunResourceSettings: (...args: unknown[]) => getRunResourceSettingsMock(...args),
  };
});

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import OpenAI from 'openai';
import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';

const toolCall = (id: string, name: string, args: object): OpenAI.ChatCompletionMessageFunctionToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Two logical servers, A and B; each key decodes to (server, tool) via toolNameMap.
const toolNameMap: Record<string, { server: string; tool: string }> = {
  mcp_a_1: { server: 'A', tool: 'op1' },
  mcp_a_2: { server: 'A', tool: 'op2' },
  mcp_a_3: { server: 'A', tool: 'op3' },
  mcp_b_1: { server: 'B', tool: 'op1' },
  mcp_b_2: { server: 'B', tool: 'op2' },
};

beforeEach(() => {
  callToolMock.mockReset();
  loadServerConfigsMock.mockReset();
  loadServerConfigsMock.mockResolvedValue([]); // no per-server caps unless a test sets them
  writeRunResourceMock.mockReset().mockResolvedValue({ skipped: 'size-cap' });
  getRunResourceSettingsMock.mockReset().mockResolvedValue({
    autoCaptureEnabled: true,
    textThresholdChars: 32,
    maxResourceBytes: 10 * 1024 * 1024,
    maxConversationBytes: 20 * 1024 * 1024,
    replaceLargeTextWithStub: false,
    toolResultMaxBytes: 1024,
    toolResultMaxLines: 200,
  });
});

describe('ModelHandler.processToolCalls concurrency (issue #252)', () => {
  it('returns tool-result messages in the model call order even when calls resolve out of order', async () => {
    // call #1 slowest, call #3 fastest — completion order is the reverse of call order.
    callToolMock.mockImplementation(async (_srv: string, tool: string) => {
      const delay = tool === 'op1' ? 40 : tool === 'op2' ? 20 : 1;
      await sleep(delay);
      return { success: true, data: { tool } };
    });

    const result = await ModelHandler.processToolCalls({
      toolCalls: [
        toolCall('c1', 'mcp_a_1', {}),
        toolCall('c2', 'mcp_a_2', {}),
        toolCall('c3', 'mcp_a_3', {}),
      ],
      toolNameMap,
    });

    expect(result.success).toBe(true);
    const msgs = (result as { value: { toolCallMessages: Array<{ tool_call_id: string; content: string }> } }).value.toolCallMessages;
    expect(msgs.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3']);
    // pairing: each id carries its own tool's result, not a neighbour's
    expect(msgs[0].content).toContain('op1');
    expect(msgs[1].content).toContain('op2');
    expect(msgs[2].content).toContain('op3');
  });

  it('runs independent calls concurrently (peak in-flight > 1, capped at the default)', async () => {
    let inFlight = 0;
    let peak = 0;
    callToolMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(15);
      inFlight -= 1;
      return { success: true, data: { ok: 1 } };
    });

    const result = await ModelHandler.processToolCalls({
      toolCalls: [
        toolCall('c1', 'mcp_a_1', {}),
        toolCall('c2', 'mcp_a_2', {}),
        toolCall('c3', 'mcp_a_3', {}),
      ],
      toolNameMap,
    });

    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(3);
    expect(peak).toBeGreaterThan(1);      // genuinely parallel
    expect(peak).toBeLessThanOrEqual(4);  // DEFAULT_TOOL_CALL_CONCURRENCY
  });

  it('respects each server\'s own maxConcurrency cap', async () => {
    loadServerConfigsMock.mockResolvedValue([
      { name: 'A', maxConcurrency: 1 },
      { name: 'B', maxConcurrency: 2 },
    ]);

    const inFlight: Record<string, number> = { A: 0, B: 0 };
    const peak: Record<string, number> = { A: 0, B: 0 };
    callToolMock.mockImplementation(async (srv: string) => {
      inFlight[srv] += 1;
      peak[srv] = Math.max(peak[srv], inFlight[srv]);
      await sleep(15);
      inFlight[srv] -= 1;
      return { success: true, data: { ok: 1 } };
    });

    const result = await ModelHandler.processToolCalls({
      toolCalls: [
        toolCall('a1', 'mcp_a_1', {}),
        toolCall('a2', 'mcp_a_2', {}),
        toolCall('a3', 'mcp_a_3', {}),
        toolCall('b1', 'mcp_b_1', {}),
        toolCall('b2', 'mcp_b_2', {}),
      ],
      toolNameMap,
    });

    expect(result.success).toBe(true);
    expect(peak.A).toBe(1);              // server A capped at 1
    expect(peak.B).toBe(2);              // server B allowed 2
  });

  it('is byte-identical to the sequential path for a single-call turn', async () => {
    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });
    const emit = jest.fn();

    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_a_1', { a: 1 })],
      toolNameMap,
      emit,
    });

    expect(result.success).toBe(true);
    const value = (result as { value: { toolCallMessages: Array<{ role: string; tool_call_id: string; content: string }>; processedToolCalls: Array<{ id: string; name: string }> } }).value;
    expect(value.toolCallMessages).toHaveLength(1);
    expect(value.toolCallMessages[0]).toMatchObject({ role: 'tool', tool_call_id: 'call1' });
    expect(value.processedToolCalls).toHaveLength(1);
    expect(value.processedToolCalls[0]).toMatchObject({ id: 'call1', name: 'mcp_a_1' });
    // event order for a lone call is exactly tool:call then tool:result
    expect(emit.mock.calls.map(([e]) => e.type)).toEqual(['tool:call', 'tool:result']);
  });

  it('stops mid-batch on Stop: every tool_call id is answered, not-started calls carry the cancelled text', async () => {
    // Force strictly sequential dispatch (cap 1) so the abort can land between calls.
    loadServerConfigsMock.mockResolvedValue([{ name: 'A', maxConcurrency: 1 }]);
    let started = 0;
    callToolMock.mockImplementation(async () => {
      started += 1;
      return { success: true, data: { ok: 1 } };
    });
    // Abort as soon as the first tool has started.
    const shouldAbort = () => started >= 1;

    const result = await ModelHandler.processToolCalls({
      toolCalls: [
        toolCall('c1', 'mcp_a_1', {}),
        toolCall('c2', 'mcp_a_2', {}),
        toolCall('c3', 'mcp_a_3', {}),
      ],
      toolNameMap,
      shouldAbort,
    });

    expect(result.success).toBe(true);
    const msgs = (result as { value: { toolCallMessages: Array<{ tool_call_id: string; content: string }> } }).value.toolCallMessages;
    // every id is answered exactly once, still in call order
    expect(msgs.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3']);
    // only the first call actually ran
    expect(started).toBe(1);
    expect(msgs[1].content).toContain('cancelled');
    expect(msgs[2].content).toContain('cancelled');
  });

  it('forwards the AbortSignal into mcpService.callTool', async () => {
    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });
    const controller = new AbortController();

    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_a_1', {})],
      toolNameMap,
      signal: controller.signal,
    });

    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledWith(
      'A',
      'op1',
      {},
      300,
      expect.any(Function),
      undefined,
      controller.signal,
      'model',
      undefined,
    );
  });

  it('fails the whole batch when execution authority is lost before a call starts', async () => {
    const authorityError = new Error('Persona lease fence is no longer current');
    const beforeToolDispatch = jest.fn(async () => {
      throw authorityError;
    });

    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_a_1', {})],
      toolNameMap,
      beforeToolDispatch,
    });

    expect(result.success).toBe(false);
    expect(callToolMock).not.toHaveBeenCalled();
    expect(beforeToolDispatch).toHaveBeenCalledTimes(1);
    if (!result.success) {
      expect(result.error.message).toContain('Persona lease fence is no longer current');
    }
  });

  it('rechecks execution authority at the final MCP side-effect boundary', async () => {
    const beforeToolDispatch = jest
      .fn<Promise<void>, []>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Persona lease expired during preparation'));

    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_a_1', {})],
      toolNameMap,
      beforeToolDispatch,
    });

    expect(result.success).toBe(false);
    expect(beforeToolDispatch).toHaveBeenCalledTimes(2);
    expect(callToolMock).not.toHaveBeenCalled();
    if (!result.success) {
      expect(result.error.message).toContain('Persona lease expired during preparation');
    }
  });

  it('drops a delayed tool result before resource, lineage, or result-event projection when the lease is lost', async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => { toolStarted = resolve; });
    callToolMock.mockImplementationOnce(async () => {
      toolStarted();
      await toolGate;
      return {
        success: true,
        data: { content: [{ type: 'text', text: 'durable payload '.repeat(200) }] },
      };
    });

    let current = true;
    const authorityError = new Error('Persona lease replaced while MCP tool was running');
    const assertCurrent = jest.fn(async () => {
      if (!current) throw authorityError;
    });
    const commitWhileCurrent = jest.fn(async <T>(task: () => Promise<T>): Promise<T> => {
      if (!current) throw authorityError;
      return task();
    }) as unknown as jest.MockedFunction<NonNullable<FlowExecutionAuthority['commitWhileCurrent']>>;
    const emit = jest.fn();

    const pending = ModelHandler.processToolCalls({
      toolCalls: [toolCall('late-call', 'mcp_a_1', {})],
      toolNameMap,
      conversationId: 'persona-conversation',
      emit,
      beforeToolDispatch: assertCurrent,
      executionAuthority: {
        assertCurrent,
        commitWhileCurrent,
        signal: new AbortController().signal,
      },
      personaAttribution: { personaId: 'persona-1', activityId: 'activity-1' },
    });

    await started;
    current = false;
    releaseTool();
    const result = await pending;

    expect(result.success).toBe(false);
    expect(writeRunResourceMock).not.toHaveBeenCalled();
    expect(commitWhileCurrent).not.toHaveBeenCalled();
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['tool:call']);
    if (!result.success) {
      expect(result.error.message).toContain('Flow execution authority was lost');
    }
  });
});
