/**
 * Tier 3 — auto-capture wiring inside ModelHandler.processToolCalls.
 *
 * Pins the seam contract:
 *  - with a conversationId, a binary tool result is captured: the tool MESSAGE
 *    carries the URI stub (never base64) and a resource:write event is emitted
 *    with the producing toolCallId (the stable lineage key — runFlow rewrites
 *    tool-message ids afterwards);
 *  - withOUT a conversationId (legacy call sites, ephemeral subflow children)
 *    nothing is captured — full backcompat;
 *  - autoCaptureEnabled=false disables the path;
 *  - a capture-layer failure keeps the original result and the run alive.
 */

const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { callTool: (...args: unknown[]) => callToolMock(...args) },
}));

const getRunResourceSettingsMock = jest.fn();
const writeRunResourceMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  getRunResourceSettings: () => getRunResourceSettingsMock(),
  writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
}));

const captureToolResultMock = jest.fn();
jest.mock('@/backend/services/runResources/capture', () => ({
  captureToolResult: (...args: unknown[]) => captureToolResultMock(...args),
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { DEFAULT_RUN_RESOURCE_SETTINGS } from '@/shared/types/runResources';
import OpenAI from 'openai';

const toolCall = (id: string, name: string, args: object): OpenAI.ChatCompletionMessageToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const toolNameMap = { mcp_srv_abc123: { server: 'srv', tool: 'screenshot' } };

const imageResult = {
  content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
};

const capturedEntry = {
  id: 'res-1',
  uri: 'flujo://run/conv-1/res-1',
  conversationId: 'conv-1',
  mimeType: 'image/png',
  size: 5,
  kind: 'image',
  encoding: 'base64',
  createdAt: 1,
  producedBy: { source: 'tool-result', toolCallId: 'call1' },
  readBy: [],
};

beforeEach(() => {
  callToolMock.mockReset();
  getRunResourceSettingsMock.mockReset();
  captureToolResultMock.mockReset();
  getRunResourceSettingsMock.mockResolvedValue({ ...DEFAULT_RUN_RESOURCE_SETTINGS });
  writeRunResourceMock.mockReset();
  writeRunResourceMock.mockResolvedValue({
    id: 'args-1',
    uri: 'flujo://run/conv-1/args-1',
    conversationId: 'conv-1',
    mimeType: 'application/json',
    size: 9000,
    kind: 'text',
    encoding: 'utf8',
    createdAt: 1,
    producedBy: { source: 'tool-args', toolCallId: 'call1' },
    readBy: [],
  });
  callToolMock.mockResolvedValue({ success: true, data: imageResult });
  captureToolResultMock.mockResolvedValue({
    result: { content: [{ type: 'text', text: '[FLUJO stored this image/png as flujo://run/conv-1/res-1]' }] },
    captured: [capturedEntry],
  });
});

describe('processToolCalls auto-capture', () => {
  it('captures with conversationId: stub in the tool message + resource:write event', async () => {
    const emit = jest.fn();
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})],
      toolNameMap,
      emit,
      conversationId: 'conv-1',
      node: { nodeId: 'node-9' },
    });

    expect(result.success).toBe(true);
    expect(captureToolResultMock).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      server: 'srv',
      toolName: 'screenshot',
      toolCallId: 'call1',
      nodeId: 'node-9',
    }));

    // The tool message carries the rewritten (stubbed) result, not the base64.
    const toolMsg = result.success ? result.value.toolCallMessages[0] : undefined;
    expect(toolMsg?.content).toContain('flujo://run/conv-1/res-1');
    expect(toolMsg?.content).not.toContain('aGVsbG8=');

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:write',
      server: 'flujo',
      uri: 'flujo://run/conv-1/res-1',
      source: 'tool-result',
      toolCallId: 'call1',
      node: { nodeId: 'node-9' },
    }));
  });

  it('does NOT capture without a conversationId (backcompat)', async () => {
    const emit = jest.fn();
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})],
      toolNameMap,
      emit,
    });

    expect(result.success).toBe(true);
    expect(getRunResourceSettingsMock).not.toHaveBeenCalled();
    expect(captureToolResultMock).not.toHaveBeenCalled();
    expect(emit.mock.calls.map(([e]) => e.type)).not.toContain('resource:write');
    // The original result reaches the message untouched.
    const toolMsg = result.success ? result.value.toolCallMessages[0] : undefined;
    expect(toolMsg?.content).toContain('aGVsbG8=');
  });

  it('respects autoCaptureEnabled=false', async () => {
    getRunResourceSettingsMock.mockResolvedValue({ ...DEFAULT_RUN_RESOURCE_SETTINGS, autoCaptureEnabled: false });
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})],
      toolNameMap,
      conversationId: 'conv-1',
    });

    expect(result.success).toBe(true);
    expect(captureToolResultMock).not.toHaveBeenCalled();
  });

  it('keeps the original result when the capture layer throws', async () => {
    captureToolResultMock.mockRejectedValue(new Error('store exploded'));
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})],
      toolNameMap,
      conversationId: 'conv-1',
    });

    expect(result.success).toBe(true); // the run survives
    const toolMsg = result.success ? result.value.toolCallMessages[0] : undefined;
    expect(toolMsg?.content).toContain('aGVsbG8='); // original passthrough
  });

  it('does not capture failed tool calls', async () => {
    callToolMock.mockResolvedValue({ success: false, error: 'boom' });
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})],
      toolNameMap,
      conversationId: 'conv-1',
    });

    expect(result.success).toBe(true);
    expect(captureToolResultMock).not.toHaveBeenCalled();
  });
});

describe('processToolCalls tool-args capture (#168)', () => {
  // A short tool result so the tool-RESULT capture path stays quiet — this suite
  // is about the tool-ARGS capture, keyed by toolCallId.
  const quietResult = { content: [{ type: 'text', text: 'ok' }] };
  // Args whose JSON string comfortably exceeds the 8192-char threshold.
  const bigArgs = { blob: 'A'.repeat(9000) };

  beforeEach(() => {
    callToolMock.mockResolvedValue({ success: true, data: quietResult });
    captureToolResultMock.mockResolvedValue({ result: quietResult, captured: [] });
  });

  it('captures oversized args as a tool-args resource and still calls the tool with full args', async () => {
    const emit = jest.fn();
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', bigArgs)],
      toolNameMap,
      emit,
      conversationId: 'conv-1',
      node: { nodeId: 'node-9' },
    });

    expect(result.success).toBe(true);

    // Captured as a run resource with source 'tool-args', keyed by toolCallId.
    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      kind: 'text',
      mimeType: 'application/json',
      producedBy: expect.objectContaining({
        source: 'tool-args',
        toolCallId: 'call1',
        server: 'srv',
        toolName: 'screenshot',
        nodeId: 'node-9',
      }),
    }));

    // resource:write emitted with the tool-args source + producing toolCallId.
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:write',
      source: 'tool-args',
      toolCallId: 'call1',
      uri: 'flujo://run/conv-1/args-1',
    }));

    // The active call still executes with the FULL args (capture is lineage-only).
    expect(callToolMock).toHaveBeenCalledWith('srv', 'screenshot', bigArgs, expect.anything(), expect.anything());
  });

  it('does NOT capture sub-threshold args', async () => {
    await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', { small: 'x' })],
      toolNameMap,
      conversationId: 'conv-1',
    });
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  it('a tool-args capture failure never fails the run', async () => {
    writeRunResourceMock.mockRejectedValue(new Error('store exploded'));
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', bigArgs)],
      toolNameMap,
      conversationId: 'conv-1',
    });
    expect(result.success).toBe(true);
    expect(callToolMock).toHaveBeenCalled();
  });

  it('does NOT capture args without a conversationId (backcompat)', async () => {
    await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', bigArgs)],
      toolNameMap,
    });
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });
});
