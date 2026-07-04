/**
 * ModelHandler.processToolCalls live-event wiring.
 *
 * Long-running MCP tools used to be invisible to the live view: no events flow
 * while a tool executes, so the chat UI's stall detector ("may be stuck")
 * fired even though the run was healthy. processToolCalls now brackets each
 * MCP call with tool:call / tool:result events and forwards server progress
 * notifications as tool:progress — every one of which refreshes the UI's
 * lastEventAt.
 */

const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { callTool: (...args: unknown[]) => callToolMock(...args) },
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import OpenAI from 'openai';

const toolCall = (id: string, name: string, args: object): OpenAI.ChatCompletionMessageToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const toolNameMap = { mcp_srv_abc123: { server: 'srv', tool: 'long_op' } };

beforeEach(() => callToolMock.mockReset());

describe('ModelHandler.processToolCalls events', () => {
  it('emits tool:call, forwards progress as tool:progress, and emits tool:result', async () => {
    callToolMock.mockImplementationOnce(async (_srv, _tool, _args, _timeout, onProgress) => {
      onProgress({ progress: 2, total: 5, message: 'halfway-ish' });
      return { success: true, data: { ok: 1 } };
    });
    const emit = jest.fn();

    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', { a: 1 })],
      toolNameMap,
      emit,
    });

    expect(result.success).toBe(true);
    // The decoded (server, tool) reached mcpService with no timeout (flow tool
    // calls may legitimately run long) and a progress callback.
    expect(callToolMock).toHaveBeenCalledWith('srv', 'long_op', { a: 1 }, undefined, expect.any(Function));

    const types = emit.mock.calls.map(([e]) => e.type);
    expect(types).toEqual(['tool:call', 'tool:progress', 'tool:result']);
    expect(emit).toHaveBeenCalledWith({
      type: 'tool:call', toolCallId: 'call1', name: 'mcp_srv_abc123', args: '{"a":1}',
    });
    expect(emit).toHaveBeenCalledWith({
      type: 'tool:progress', toolCallId: 'call1', name: 'mcp_srv_abc123',
      progress: 2, total: 5, message: 'halfway-ish',
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool:result', toolCallId: 'call1', name: 'mcp_srv_abc123', isError: false,
    }));
  });

  it('emits an isError tool:result when the tool fails', async () => {
    callToolMock.mockResolvedValueOnce({ success: false, error: 'boom' });
    const emit = jest.fn();

    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})],
      toolNameMap,
      emit,
    });

    expect(result.success).toBe(true); // per-call errors become tool messages, not a failed batch
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool:result', toolCallId: 'call1', isError: true,
    }));
  });

  it('still processes tool calls when no emitter is provided', async () => {
    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });

    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})],
      toolNameMap,
    });

    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });
});
