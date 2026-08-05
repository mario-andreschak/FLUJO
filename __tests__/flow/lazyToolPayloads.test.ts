import {
  hydrateLazyToolPayloads,
  projectLazyToolPayloads,
} from '@/backend/execution/flow/lazyToolPayloads';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { RunResourceEntry } from '@/shared/types/runResources';
import {
  getRunResourceSettings,
  listRunResources,
  readRunResource,
} from '@/backend/services/runResources';
import { boundToolResult } from '@/backend/services/runResources/boundToolResult';

jest.mock('@/backend/services/runResources', () => ({
  getRunResourceSettings: jest.fn(),
  listRunResources: jest.fn(),
  readRunResource: jest.fn(),
}));
jest.mock('@/backend/services/runResources/boundToolResult', () => ({
  boundToolResult: jest.fn(),
}));

const listMock = jest.mocked(listRunResources);
const readMock = jest.mocked(readRunResource);
const settingsMock = jest.mocked(getRunResourceSettings);
const boundMock = jest.mocked(boundToolResult);

function resource(
  id: string,
  source: 'tool-args' | 'tool-result',
  toolCallId: string,
  size: number,
): RunResourceEntry {
  return {
    id,
    uri: `flujo://run/source-conversation/${id}`,
    conversationId: 'source-conversation',
    mimeType: 'application/json',
    size,
    kind: 'text',
    encoding: 'utf8',
    createdAt: 10,
    producedBy: {
      source,
      payloadRole: source === 'tool-args' ? 'tool-arguments' : 'tool-message',
      toolCallId,
      server: 'server',
      toolName: 'large_tool',
    },
    readBy: [],
  };
}

function transcript(args: string, result: string): FlujoChatMessage[] {
  return [
    {
      id: 'assistant-1',
      timestamp: 1,
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'large_tool', arguments: args },
      }],
    },
    {
      id: 'tool-1',
      timestamp: 2,
      role: 'tool',
      tool_call_id: 'call-1',
      content: result,
    },
  ] as FlujoChatMessage[];
}

beforeEach(() => {
  jest.resetAllMocks();
  settingsMock.mockResolvedValue({
    autoCaptureEnabled: true,
    textThresholdChars: 8192,
    maxResourceBytes: 1024 * 1024,
    maxConversationBytes: 2 * 1024 * 1024,
    replaceLargeTextWithStub: false,
    toolResultMaxLines: 2000,
    toolResultMaxBytes: 50 * 1024,
    retentionAgeDays: 7,
  });
  boundMock.mockImplementation(async (input) => ({ content: input.content, spilled: false }));
});

describe('lazy tool payload projection and hydration', () => {
  it('returns short response previews with exact expansion references without mutating canonical messages', async () => {
    const args = JSON.stringify({ query: 'a'.repeat(5000) });
    const result = JSON.stringify({ output: 'b'.repeat(5000) });
    const canonical = transcript(args, result);
    listMock.mockResolvedValue([
      resource('args-resource', 'tool-args', 'call-1', Buffer.byteLength(args)),
      resource('result-resource', 'tool-result', 'call-1', Buffer.byteLength(result)),
    ]);

    const projected = await projectLazyToolPayloads(canonical, 'source-conversation');
    const assistant = projected[0] as FlujoChatMessage & { role: 'assistant' };
    const tool = projected[1] as FlujoChatMessage & { role: 'tool' };

    expect(assistant.tool_calls![0].function.arguments.length).toBeLessThan(args.length);
    expect(assistant.toolPayloads?.['call-1']?.arguments).toMatchObject({
      uri: 'flujo://run/source-conversation/args-resource',
      size: Buffer.byteLength(args),
    });
    expect(typeof tool.content === 'string' ? tool.content.length : Infinity).toBeLessThan(result.length);
    expect(tool.toolPayloads?.['call-1']?.result?.href).toContain('/result-resource/content');
    expect(canonical[0].tool_calls![0].function.arguments).toBe(args);
    expect(canonical[1].content).toBe(result);
  });

  it('restores canonical tool bodies without reading resources on a normal follow-up turn', async () => {
    const args = JSON.stringify({ query: 'a'.repeat(5000) });
    const result = JSON.stringify({ output: 'b'.repeat(5000) });
    const canonical = transcript(args, result);
    listMock.mockResolvedValue([
      resource('args-resource', 'tool-args', 'call-1', args.length),
      resource('result-resource', 'tool-result', 'call-1', result.length),
    ]);
    const projected = await projectLazyToolPayloads(canonical, 'source-conversation');

    const hydrated = await hydrateLazyToolPayloads(projected, canonical, 'source-conversation') as FlujoChatMessage[];

    expect(hydrated[0].tool_calls![0].function.arguments).toBe(args);
    expect(hydrated[1].content).toBe(result);
    expect(hydrated[0].toolPayloads).toBeUndefined();
    expect(hydrated[1].toolPayloads).toBeUndefined();
    expect(readMock).not.toHaveBeenCalled();
  });

  it('reads validated exact resources when a transcript is split into a new conversation', async () => {
    const args = JSON.stringify({ query: 'full args' });
    const result = JSON.stringify({ output: 'full result' });
    const argsEntry = resource('args-resource', 'tool-args', 'call-1', args.length);
    const resultEntry = resource('result-resource', 'tool-result', 'call-1', result.length);
    const projected = transcript('args preview', 'result preview');
    projected[0].toolPayloads = { 'call-1': { arguments: {
      uri: argsEntry.uri, href: '/args', size: argsEntry.size,
    } } };
    projected[1].toolPayloads = { 'call-1': { result: {
      uri: resultEntry.uri, href: '/result', size: resultEntry.size,
    } } };
    readMock.mockImplementation(async (uri) => {
      const entry = uri === argsEntry.uri ? argsEntry : resultEntry;
      const text = uri === argsEntry.uri ? args : result;
      return { entry, contents: { contents: [{ uri, mimeType: 'application/json', text }] } };
    });

    const hydrated = await hydrateLazyToolPayloads(projected, [], 'new-conversation') as FlujoChatMessage[];

    expect(hydrated[0].tool_calls![0].function.arguments).toBe(args);
    expect(hydrated[1].content).toBe(result);
    expect(boundMock).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'new-conversation',
      toolCallId: 'call-1',
      content: result,
    }));
  });
});
