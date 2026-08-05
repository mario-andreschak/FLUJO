import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type OpenAI from 'openai';
import ChatMessages, { ToolCallTimeline } from '@/frontend/components/Chat/ChatMessages';
import type { ToolCallPair } from '@/frontend/components/Chat/toolCallPairing';
import type { FlujoChatMessage } from '@/shared/types/chat';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({
  __esModule: true,
  default: ({
    serverName,
    uri,
    defaultExpanded,
    linkedToolCallCount,
    toolUpdateId,
  }: {
    serverName: string;
    uri: string;
    defaultExpanded?: boolean;
    linkedToolCallCount?: number;
    toolUpdateId?: string;
  }) => (
    <div
      data-testid="mcp-app-frame"
      data-server={serverName}
      data-uri={uri}
      data-expanded={String(Boolean(defaultExpanded))}
      data-call-count={String(linkedToolCallCount ?? 1)}
      data-update-id={toolUpdateId}
    />
  ),
}));

function appPair(id: string, resultId: string): ToolCallPair<FlujoChatMessage> {
  const toolCall: OpenAI.ChatCompletionMessageFunctionToolCall = {
    id,
    type: 'function',
    function: { name: `browser_${id}`, arguments: '{}' },
  };
  return {
    toolCall,
    result: {
      id: resultId,
      timestamp: 1,
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify({ id }),
      ui: { serverName: 'browser', uri: 'ui://browser/view' },
    },
  };
}

describe('Chat MCP App grouping', () => {
  it('does not fetch or parse a lazy tool payload until its timeline node is expanded', async () => {
    const fetchMock = jest.fn(async (url: string) => ({
      ok: true,
      text: async () => url.includes('args')
        ? JSON.stringify({ query: 'full-argument-value' })
        : JSON.stringify({ output: 'full-result-value' }),
    }));
    (global as any).fetch = fetchMock;
    const pair: ToolCallPair<FlujoChatMessage> = {
      toolCall: {
        id: 'lazy-call',
        type: 'function',
        function: { name: 'lazy_tool', arguments: 'argument preview' },
      },
      result: {
        id: 'lazy-result',
        timestamp: 2,
        role: 'tool',
        tool_call_id: 'lazy-call',
        content: 'result preview',
      },
      argumentPayload: {
        uri: 'flujo://run/conversation/lazy-args', href: '/payload/args', size: 9000,
      },
      resultPayload: {
        uri: 'flujo://run/conversation/lazy-result', href: '/payload/result', size: 12000,
      },
    };

    render(<ToolCallTimeline pairs={[pair]} messageId="assistant-lazy" />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/full-argument-value/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show call and result' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/full-argument-value/)).toBeInTheDocument();
    expect(await screen.findByText(/full-result-value/)).toBeInTheDocument();
  });

  it('renders one collapsed App frame for many historical calls sharing a resource', () => {
    render(
      <ToolCallTimeline
        pairs={[
          appPair('navigate', 'result-1'),
          appPair('click', 'result-2'),
          appPair('screenshot', 'result-3'),
        ]}
        messageId="assistant-1"
        autoOpenMcpApps
      />,
    );

    const frames = screen.getAllByTestId('mcp-app-frame');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveAttribute('data-expanded', 'false');
    expect(frames[0]).toHaveAttribute('data-call-count', '3');
    expect(frames[0]).toHaveAttribute('data-update-id', 'result-3');
  });

  it('auto-opens only when the latest result is a fresh live result and not dismissed', () => {
    const pairs = [appPair('navigate', 'result-1'), appPair('click', 'result-2')];
    const { rerender } = render(
      <ToolCallTimeline
        pairs={pairs}
        messageId="assistant-1"
        autoOpenMcpApps
        autoOpenMcpAppResultIds={new Set(['result-2'])}
      />,
    );

    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-expanded', 'true');

    rerender(
      <ToolCallTimeline
        pairs={pairs}
        messageId="assistant-1"
        autoOpenMcpApps
        autoOpenMcpAppResultIds={new Set(['result-2'])}
        dismissedMcpAppKeys={new Set(['browser::ui://browser/view'])}
      />,
    );
    expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-expanded', 'false');
  });

  it('assigns one conversation-wide View owner to the latest result for a resource', () => {
    const first = appPair('navigate', 'result-1');
    const second = appPair('click', 'result-2');
    const messages: FlujoChatMessage[] = [
      {
        id: 'assistant-1',
        timestamp: 1,
        role: 'assistant',
        content: 'First browser step',
        tool_calls: [first.toolCall],
      },
      first.result!,
      {
        id: 'assistant-2',
        timestamp: 2,
        role: 'assistant',
        content: 'Second browser step',
        tool_calls: [second.toolCall],
      },
      second.result!,
    ];

    render(
      <ChatMessages
        messages={messages}
        conversationId="conversation-1"
        onToggleDisabled={() => undefined}
        onSplitConversation={() => undefined}
      />,
    );

    const frames = screen.getAllByTestId('mcp-app-frame');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveAttribute('data-update-id', 'result-2');
  });
});
