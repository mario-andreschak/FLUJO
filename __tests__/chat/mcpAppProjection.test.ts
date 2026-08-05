import {
  groupMcpAppOccurrences,
  latestMcpAppResultIdsByResource,
  observeNewMcpAppResultIds,
} from '@/frontend/components/Chat/mcpAppProjection';
import type { ToolCallPair } from '@/frontend/components/Chat/toolCallPairing';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type OpenAI from 'openai';

function pair(
  id: string,
  serverName: string,
  uri: string,
  resultId: string,
  toolName = `tool_${id}`,
): ToolCallPair<FlujoChatMessage> {
  const toolCall: OpenAI.ChatCompletionMessageFunctionToolCall = {
    id,
    type: 'function',
    function: { name: toolName, arguments: JSON.stringify({ id }) },
  };
  return {
    toolCall,
    result: {
      id: resultId,
      timestamp: 1,
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify({ id }),
      ui: { serverName, uri, toolName },
    },
  };
}

describe('groupMcpAppOccurrences', () => {
  it('groups many tool calls attached to the same resource into one App', () => {
    const groups = groupMcpAppOccurrences([
      pair('call-1', 'browser', 'ui://browser/view', 'result-1', 'navigate'),
      pair('call-2', 'browser', 'ui://browser/view', 'result-2', 'click'),
      pair('call-3', 'browser', 'ui://browser/view', 'result-3', 'screenshot'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('browser::ui://browser/view');
    expect(groups[0].occurrences).toHaveLength(3);
    expect(groups[0].latest).toMatchObject({
      toolName: 'screenshot',
      updateId: 'result-3',
      resultMessageId: 'result-3',
    });
  });

  it('keeps server identity and resource identity separate', () => {
    const groups = groupMcpAppOccurrences([
      pair('a', 'browser-a', 'ui://shared/view', 'ra'),
      pair('b', 'browser-b', 'ui://shared/view', 'rb'),
      pair('c', 'browser-a', 'ui://other/view', 'rc'),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      'browser-a::ui://shared/view',
      'browser-b::ui://shared/view',
      'browser-a::ui://other/view',
    ]);
  });

  it('uses forwarded App tool arguments when present', () => {
    const item = pair('outer', 'browser', 'ui://browser/view', 'result');
    item.result!.ui!.toolArgs = JSON.stringify({ forwarded: true });

    expect(groupMcpAppOccurrences([item])[0].latest.toolArgs)
      .toBe(JSON.stringify({ forwarded: true }));
  });
});

describe('observeNewMcpAppResultIds', () => {
  it('treats the first snapshot as hydration and only reports later results once', () => {
    const observed = new Map<string, Set<string>>();
    const first = [pair('call-1', 'browser', 'ui://browser/view', 'result-1').result!];
    const second = [
      ...first,
      pair('call-2', 'browser', 'ui://browser/view', 'result-2').result!,
    ];

    expect(observeNewMcpAppResultIds(observed, 'conversation-1', first)).toEqual([]);
    expect(observeNewMcpAppResultIds(observed, 'conversation-1', second)).toEqual(['result-2']);
    expect(observeNewMcpAppResultIds(observed, 'conversation-1', second)).toEqual([]);
  });

  it('keeps hydration baselines isolated by conversation', () => {
    const observed = new Map<string, Set<string>>();
    const messages = [pair('call-1', 'browser', 'ui://browser/view', 'result-1').result!];

    expect(observeNewMcpAppResultIds(observed, 'conversation-1', messages)).toEqual([]);
    expect(observeNewMcpAppResultIds(observed, 'conversation-2', messages)).toEqual([]);
  });

  it('selects only the latest fresh result for each resource', () => {
    const messages = [
      pair('a1', 'browser', 'ui://browser/view', 'r1').result!,
      pair('f1', 'files', 'ui://files/diff', 'rf').result!,
      pair('a2', 'browser', 'ui://browser/view', 'r2').result!,
    ];

    expect(latestMcpAppResultIdsByResource(messages, ['r1', 'rf', 'r2']))
      .toEqual(['r2', 'rf']);
  });
});
