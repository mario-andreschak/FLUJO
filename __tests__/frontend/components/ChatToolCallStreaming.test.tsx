import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type OpenAI from 'openai';
import { ToolCallTimeline } from '@/frontend/components/Chat/ChatMessages';
import type { ToolCallPair } from '@/frontend/components/Chat/toolCallPairing';
import type { FlujoChatMessage } from '@/shared/types/chat';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({
  __esModule: true,
  default: () => <div data-testid="mcp-app-frame" />,
}));

/**
 * Issue #337 — while a tool call's arguments are still streaming in, the card
 * must show the partial payload as intentional progress rather than as broken
 * or missing output, and must never throw on an incomplete JSON prefix.
 */
function streamingPair(args: string): ToolCallPair<FlujoChatMessage> {
  const toolCall: OpenAI.ChatCompletionMessageFunctionToolCall = {
    id: 'call-stream',
    type: 'function',
    function: { name: 'search_docs', arguments: args },
  };
  return { toolCall };
}

const expand = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Show call and result' }));

describe('streamed tool-call arguments (#337)', () => {
  it('renders a partial payload with a streaming affordance and no result yet', () => {
    render(
      <ToolCallTimeline pairs={[streamingPair('{"query":"live streaming ar')]} messageId="assistant-1" />,
    );
    expand();

    expect(screen.getByText('streaming…')).toBeInTheDocument();
    // The visible preview is the repaired prefix, not an error or empty box.
    expect(screen.getByText(/live streaming ar/)).toBeInTheDocument();
  });

  it('drops the streaming affordance once the arguments are complete', () => {
    const { rerender } = render(
      <ToolCallTimeline pairs={[streamingPair('{"query":"live streaming ar')]} messageId="assistant-1" />,
    );
    expand();
    expect(screen.getByText('streaming…')).toBeInTheDocument();

    rerender(
      <ToolCallTimeline
        pairs={[streamingPair('{"query":"live streaming arguments","limit":2}')]}
        messageId="assistant-1"
      />,
    );

    expect(screen.queryByText('streaming…')).not.toBeInTheDocument();
    expect(screen.getByText(/"limit": 2/)).toBeInTheDocument();
  });

  it('survives every prefix of a payload, including mid-escape truncation', () => {
    const payload = JSON.stringify({ path: 'C:\\Users\\Moe\\notes.md', emoji: '🙂' });
    for (let offset = 1; offset <= payload.length; offset += 1) {
      const view = render(
        <ToolCallTimeline
          pairs={[streamingPair(payload.slice(0, offset))]}
          messageId={`assistant-${offset}`}
        />,
      );
      expect(() => expand()).not.toThrow();
      view.unmount();
    }
  });
});
