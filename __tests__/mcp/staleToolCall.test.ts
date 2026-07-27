/**
 * Issue #255 — reject stale tool calls after an MCP server re-registers its tools.
 *
 * ModelHandler.processToolCalls now runs a staleness guard between decoding the
 * model-facing name and dispatching to mcpService. If the tool's advertise-time
 * identity (client generation + input-schema hash, stored in toolNameMap) no
 * longer matches the current registration, the call is answered with a tool
 * ERROR and is NOT dispatched against the re-created server. When nothing
 * changed, dispatch is byte-for-byte unchanged.
 */

const callToolMock = jest.fn();
const getClientMock = jest.fn();
const getClientGenerationMock = jest.fn();
const getToolSchemaHashMock = jest.fn();

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: (...args: unknown[]) => callToolMock(...args),
    getClient: (...args: unknown[]) => getClientMock(...args),
    getClientGeneration: (...args: unknown[]) => getClientGenerationMock(...args),
    getToolSchemaHash: (...args: unknown[]) => getToolSchemaHashMock(...args),
  },
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import OpenAI from 'openai';

const toolCall = (id: string, name: string, args: object): OpenAI.ChatCompletionMessageToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const NAME = 'mcp_srv_abc123';

beforeEach(() => {
  callToolMock.mockReset();
  getClientMock.mockReset().mockReturnValue({}); // a live client by default
  getClientGenerationMock.mockReset().mockReturnValue(1);
  getToolSchemaHashMock.mockReset().mockReturnValue('HASH');
});

describe('processToolCalls staleness guard (#255)', () => {
  it('dispatches normally when the identity still matches', async () => {
    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('c1', NAME, { a: 1 })],
      toolNameMap: { [NAME]: { server: 'srv', tool: 'op', clientGeneration: 1, schemaHash: 'HASH' } },
    });
    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledWith('srv', 'op', { a: 1 }, 300, expect.any(Function), undefined, undefined);
  });

  it('rejects the call (no dispatch) after a client-generation bump (reconnect)', async () => {
    getClientGenerationMock.mockReturnValue(2); // advertised at gen 1, now gen 2
    const emit = jest.fn();
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('c1', NAME, { a: 1 })],
      toolNameMap: { [NAME]: { server: 'srv', tool: 'op', clientGeneration: 1, schemaHash: 'HASH' } },
      emit,
    });
    expect(result.success).toBe(true); // per-call errors are tool messages, not a failed batch
    if (!result.success) throw new Error('expected success');
    expect(callToolMock).not.toHaveBeenCalled();
    const msg = result.value.toolCallMessages.find((m) => (m as { tool_call_id?: string }).tool_call_id === 'c1');
    expect(msg?.content).toMatch(/re-registered|reconnected/i);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool:result', toolCallId: 'c1', isError: true }));
  });

  it('rejects the call (no dispatch) after a schema change', async () => {
    getToolSchemaHashMock.mockReturnValue('NEWHASH'); // advertised HASH, now NEWHASH
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('c1', NAME, {})],
      toolNameMap: { [NAME]: { server: 'srv', tool: 'op', clientGeneration: 1, schemaHash: 'HASH' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(callToolMock).not.toHaveBeenCalled();
    const msg = result.value.toolCallMessages.find((m) => (m as { tool_call_id?: string }).tool_call_id === 'c1');
    expect(msg?.content).toMatch(/schema/i);
  });

  it('rejects the call when the server client is gone', async () => {
    getClientMock.mockReturnValue(undefined);
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('c1', NAME, {})],
      toolNameMap: { [NAME]: { server: 'srv', tool: 'op', clientGeneration: 1, schemaHash: 'HASH' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(callToolMock).not.toHaveBeenCalled();
    const msg = result.value.toolCallMessages.find((m) => (m as { tool_call_id?: string }).tool_call_id === 'c1');
    expect(msg?.content).toMatch(/no longer available/i);
  });

  it('does not guard legacy entries with no identity token (back-compat)', async () => {
    getClientMock.mockReturnValue(undefined); // would fail IF the guard ran
    callToolMock.mockResolvedValueOnce({ success: true, data: { ok: 1 } });
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('c1', NAME, {})],
      toolNameMap: { [NAME]: { server: 'srv', tool: 'op' } }, // no clientGeneration/schemaHash
    });
    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });
});
