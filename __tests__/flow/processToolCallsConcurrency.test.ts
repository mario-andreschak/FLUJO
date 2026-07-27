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
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: (...args: unknown[]) => callToolMock(...args),
    loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
  },
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import OpenAI from 'openai';

const toolCall = (id: string, name: string, args: object): OpenAI.ChatCompletionMessageToolCall => ({
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
    expect(callToolMock).toHaveBeenCalledWith('A', 'op1', {}, 300, expect.any(Function), undefined, controller.signal);
  });
});
