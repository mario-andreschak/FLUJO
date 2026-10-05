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
import { createHash } from 'node:crypto';
import { DEFAULT_RUN_RESOURCE_SETTINGS } from '@/shared/types/runResources';
import OpenAI from 'openai';

const toolCall = (id: string, name: string, args: object): OpenAI.ChatCompletionMessageFunctionToolCall => ({
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
    media: [{
      type: 'image',
      mimeType: 'image/png',
      resourceUri: 'flujo://run/conv-1/res-1',
    }],
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
    const toolMessage = (result as { value: { toolCallMessages: Array<{ content: string }> } }).value.toolCallMessages[0];
    const resultEvent = emit.mock.calls.map(([row]) => row).find(row => row.type === 'tool:result');
    expect(resultEvent.resultContentBinding).toEqual({ serialization: 'utf8-string-v1',
      sha256: createHash('sha256').update(toolMessage.content, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(toolMessage.content, 'utf8') });
    expect(resultEvent.resultContentBinding.sha256)
      .not.toBe(createHash('sha256').update(JSON.stringify(imageResult), 'utf8').digest('hex'));
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
    expect(toolMsg?.media).toEqual([expect.objectContaining({
      type: 'image',
      resourceUri: 'flujo://run/conv-1/res-1',
    })]);

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:write',
      server: 'flujo',
      uri: 'flujo://run/conv-1/res-1',
      source: 'tool-result',
      toolCallId: 'call1',
      node: { nodeId: 'node-9' },
    }));
  });

  it('delivers inline media without a conversationId while keeping base64 out of tool text', async () => {
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
    const toolMsg = result.success ? result.value.toolCallMessages[0] : undefined;
    expect(toolMsg?.content).not.toContain('aGVsbG8=');
    expect(toolMsg?.content).toContain('native image input');
    expect(toolMsg?.media).toEqual([expect.objectContaining({
      type: 'image',
      mimeType: 'image/png',
      data: 'aGVsbG8=',
    })]);
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

  it('captures an exact transcript-level result for expansion-time loading', async () => {
    const largeText = 'x'.repeat(DEFAULT_RUN_RESOURCE_SETTINGS.textThresholdChars + 10);
    const data = { content: [{ type: 'text', text: largeText }] };
    callToolMock.mockResolvedValue({ success: true, data });
    captureToolResultMock.mockResolvedValue({ result: data, captured: [] });

    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})],
      toolNameMap,
      conversationId: 'conv-1',
      node: { nodeId: 'node-9' },
    });

    expect(result.success).toBe(true);
    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      kind: 'text',
      producedBy: expect.objectContaining({
        source: 'tool-result',
        payloadRole: 'tool-message',
        toolCallId: 'call1',
      }),
    }));
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
    expect(toolMsg?.content).not.toContain('aGVsbG8=');
    expect(toolMsg?.content).toContain('native image input');
    expect(toolMsg?.media).toEqual([expect.objectContaining({
      type: 'image',
      mimeType: 'image/png',
      data: 'aGVsbG8=',
    })]);
  });

  it.each(['stored', 'refused'])('binds the exact bounded tool-message content after a %s spill', async (spill) => {
    const data = { isError: false, content: [{ type: 'text', text: 'café🙂'.repeat(250) }] };
    const full = JSON.stringify(data);
    callToolMock.mockResolvedValue({ success: true, data });
    captureToolResultMock.mockResolvedValue({ result: data, captured: [] });
    getRunResourceSettingsMock.mockResolvedValue({ ...DEFAULT_RUN_RESOURCE_SETTINGS,
      toolResultTruncationEnabled: true, toolResultMaxBytes: 128, toolResultMaxLines: 0 });
    writeRunResourceMock.mockResolvedValue(spill === 'stored'
      ? { ...capturedEntry, mimeType: 'text/plain', kind: 'text', size: Buffer.byteLength(full, 'utf8') }
      : { skipped: 'size-cap' });
    const emit = jest.fn();
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})], toolNameMap,
      conversationId: 'conv-1', emit,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'text/plain', data: { text: full },
      producedBy: expect.objectContaining({ source: 'tool-result', payloadRole: 'tool-message', toolCallId: 'call1' }),
    }));
    const content = result.value.toolCallMessages[0].content;
    expect(typeof content).toBe('string');
    const message = content as string;
    expect(message).toContain('tool result truncated for context');
    expect(message).not.toBe(full);
    if (spill === 'stored') expect(message).toContain(capturedEntry.uri);
    else expect(message).toContain('the full result could not be stored');
    const resultEvents = emit.mock.calls.map(([row]) => row).filter(row => row.type === 'tool:result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({ toolCallId: 'call1', isError: false,
      result: message.length > 500 ? `${message.slice(0, 500)}…` : message,
      resultContentBinding: { serialization: 'utf8-string-v1',
        sha256: createHash('sha256').update(message, 'utf8').digest('hex'), bytes: Buffer.byteLength(message, 'utf8') } });
    expect(resultEvents[0].resultContentBinding.sha256)
      .not.toBe(createHash('sha256').update(full, 'utf8').digest('hex'));
  });

  it.each([['text', 'stored'], ['text', 'refused'], ['media', 'stored'], ['media', 'refused']])(
    'protects protocol %s errors through capture and a %s context spill', async (kind, spill) => {
    const start = { type: 'text', text: 'START_DIAGNOSTIC' };
    const tail = { type: 'text', text: 'café🙂\n'.repeat(150) + 'END_DIAGNOSTIC' };
    const data = { isError: true, content: [start, ...(kind === 'media' ? imageResult.content : []), tail] };
    // Rewriting can omit isError. Status must still come from the ORIGINAL
    // protocol payload, while this protected content proceeds to the bound.
    const protectedData = { content: [start, ...(kind === 'media'
      ? [{ type: 'text', text: `[stored image at ${capturedEntry.uri}]` }] : []), tail] };
    const full = JSON.stringify(protectedData);
    callToolMock.mockResolvedValue({ success: true, data });
    captureToolResultMock.mockResolvedValue({ result: protectedData,
      captured: kind === 'media' ? [capturedEntry] : [],
      media: kind === 'media' ? [{ type: 'image', mimeType: 'image/png', resourceUri: capturedEntry.uri }] : [],
    });
    getRunResourceSettingsMock.mockResolvedValue({ ...DEFAULT_RUN_RESOURCE_SETTINGS,
      autoCaptureEnabled: true, textThresholdChars: 32,
      toolResultTruncationEnabled: true, toolResultMaxBytes: 128, toolResultMaxLines: 2 });
    const spillUri = 'flujo://run/conv-1/error-overflow';
    writeRunResourceMock.mockResolvedValue(spill === 'stored'
      ? { ...capturedEntry, uri: spillUri, mimeType: 'text/plain', kind: 'text', size: Buffer.byteLength(full, 'utf8') }
      : { skipped: 'size-cap' });
    const emit = jest.fn();
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})], toolNameMap,
      conversationId: 'conv-1', emit,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(Buffer.byteLength(full, 'utf8')).toBeGreaterThan(128);
    expect(full.length).toBeGreaterThan(500);
    expect(captureToolResultMock).toHaveBeenCalledWith(expect.objectContaining({ result: data, toolCallId: 'call1' }));
    expect(writeRunResourceMock).toHaveBeenCalledTimes(1);
    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'text/plain', data: { text: full },
      producedBy: expect.objectContaining({ source: 'tool-result', payloadRole: 'tool-message', toolCallId: 'call1' }),
    }));
    expect(result.value.toolCallMessages).toHaveLength(1);
    const message = result.value.toolCallMessages[0];
    expect(message).toMatchObject({ role: 'tool', tool_call_id: 'call1' });
    expect(typeof message.content).toBe('string');
    const content = message.content as string;
    expect(content).not.toBe(full);
    expect(content).toContain('tool result truncated for context');
    expect(content).toContain('START_DIAGNOSTIC');
    expect(content).toContain('END_DIAGNOSTIC');
    expect(content).not.toContain('aGVsbG8=');
    if (spill === 'stored') expect(content).toContain(spillUri);
    else expect(content).toContain('the full result could not be stored');
    if (kind === 'media') expect(message.media).toEqual([expect.objectContaining({ resourceUri: capturedEntry.uri })]);
    else expect(message).not.toHaveProperty('media');
    expect(result.value.processedToolCalls[0]).toMatchObject({ id: 'call1', result: content, exitCode: 1 });
    const events = emit.mock.calls.map(([row]) => row);
    const results = events.filter(row => row.type === 'tool:result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: 'call1', isError: true,
      result: content.length > 500 ? `${content.slice(0, 500)}…` : content });
    expect(results[0]).not.toHaveProperty('resultContentBinding');
  });

  it.each(['disabled', 'failed'])('preserves inline error media and failure status when capture is %s', async (capture) => {
    const data = { isError: true, content: [{ type: 'text', text: 'Synthetic MCP tool failure' }, ...imageResult.content] };
    callToolMock.mockResolvedValue({ success: true, data });
    getRunResourceSettingsMock.mockResolvedValue({ ...DEFAULT_RUN_RESOURCE_SETTINGS,
      autoCaptureEnabled: capture !== 'disabled' });
    if (capture === 'failed') captureToolResultMock.mockRejectedValue(new Error('Synthetic capture refusal'));
    const emit = jest.fn();
    const result = await ModelHandler.processToolCalls({
      toolCalls: [toolCall('call1', 'mcp_srv_abc123', {})], toolNameMap, conversationId: 'conv-1', emit,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    if (capture === 'disabled') expect(captureToolResultMock).not.toHaveBeenCalled();
    else expect(captureToolResultMock).toHaveBeenCalledTimes(1);
    const message = result.value.toolCallMessages[0];
    expect(message.content).toContain('Synthetic MCP tool failure');
    expect(message.content).toContain('native image input');
    expect(message.content).not.toContain('aGVsbG8=');
    expect(message.media).toEqual([expect.objectContaining({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' })]);
    expect(result.value.processedToolCalls[0]).toMatchObject({ result: message.content, exitCode: 1 });
    const results = emit.mock.calls.map(([row]) => row).filter(row => row.type === 'tool:result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: 'call1', isError: true, result: message.content });
    expect(results[0]).not.toHaveProperty('resultContentBinding');
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
    // Issue #357: the call also carries a per-call AbortSignal so the user can
    // cancel this tool call while it is in flight.
    expect(callToolMock).toHaveBeenCalledWith(
      'srv',
      'screenshot',
      bigArgs,
      expect.anything(),
      expect.anything(),
      undefined,
      expect.any(AbortSignal),
      'model',
      'conversation:conv-1',
      { conversationId: 'conv-1' },
    );
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
