/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ThemeProvider } from '@mui/material/styles';
import ChatMessages from '@/frontend/components/Chat/ChatMessages';
import { createAppTheme } from '@/frontend/utils/muiTheme';
import type { FlujoChatMessage } from '@/shared/types/chat';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({
  __esModule: true,
  default: () => null,
}));

function injectedCss(): string {
  return Array.from(document.styleSheets).flatMap((sheet) => {
    try {
      return Array.from(sheet.cssRules).map((rule) => rule.cssText);
    } catch {
      return [];
    }
  }).join('\n');
}

function renderChat(messages: FlujoChatMessage[]) {
  return render(
    <ThemeProvider theme={createAppTheme('light')}>
      <ChatMessages
        messages={messages}
        conversationId="conversation-actions"
        onToggleDisabled={() => undefined}
        onSplitConversation={() => undefined}
      />
    </ThemeProvider>,
  );
}

describe('chat message header actions', () => {
  const writeText = jest.fn<Promise<void>, [string]>();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  it('copies a string message from the icon beside the overflow menu', async () => {
    renderChat([{
      id: 'user-copy',
      timestamp: 1,
      role: 'user',
      content: 'Copy this exact message',
    } as FlujoChatMessage]);

    const copy = screen.getByRole('button', { name: 'Copy message' });
    const more = screen.getByRole('button', { name: 'More message actions' });
    expect(copy.parentElement).toBe(more.parentElement);

    fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Copy this exact message'));
    expect(await screen.findByRole('button', { name: 'Message copied' })).toBeInTheDocument();
  });

  it('copies all textual parts of a multipart message', async () => {
    renderChat([{
      id: 'assistant-copy',
      timestamp: 2,
      role: 'assistant',
      content: [
        { type: 'text', text: 'First part' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        { type: 'text', text: 'Second part' },
      ],
    } as unknown as FlujoChatMessage]);

    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('First part\nSecond part'));
  });

  it('adds a high-contrast selection override to modern light user bubbles', () => {
    document.documentElement.classList.add('modern-theme');
    renderChat([{
      id: 'user-selection',
      timestamp: 3,
      role: 'user',
      content: 'Clearly selectable',
    } as FlujoChatMessage]);

    const css = injectedCss();
    expect(css).toContain('modern-theme');
    expect(css).toContain('::selection');
    expect(css).toContain(createAppTheme('light').palette.primary.dark);
    document.documentElement.classList.remove('modern-theme');
  });

  it('loads durable history only after the user asks for it', () => {
    const onLoadEarlierMessages = jest.fn();
    render(
      <ThemeProvider theme={createAppTheme('light')}>
        <ChatMessages
          messages={[{
            id: 'recent-only',
            timestamp: 4,
            role: 'assistant',
            content: 'Recent snapshot',
          } as FlujoChatMessage]}
          conversationId="conversation-bounded"
          hasEarlierMessages
          onLoadEarlierMessages={onLoadEarlierMessages}
          onToggleDisabled={() => undefined}
          onSplitConversation={() => undefined}
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load full history' }));
    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });
});

describe('inter-agent message provenance', () => {
  const delivery: FlujoChatMessage = {
    id: 'agent-delivery',
    timestamp: 1,
    role: 'user',
    injected: true,
    content: 'Please check the migration result.',
    agentMessage: {
      senderConversationId: 'research-conversation',
      senderName: 'Research agent',
      recipientConversationId: 'conversation-actions',
      kind: 'message',
    },
  };

  it('identifies an agent delivery separately from a human user message', () => {
    renderChat([delivery, {
      id: 'human-message',
      timestamp: 2,
      role: 'user',
      content: 'My own instruction.',
    }]);

    const sender = screen.getByText(/^Message from Research agent •/);
    expect(sender).toHaveAttribute('title', 'research-conversation');
    const agentBubble = sender.closest('[data-ask-flujo-message-id]') as HTMLElement;
    expect(within(agentBubble).queryByText(/^You •/)).not.toBeInTheDocument();
    expect(within(agentBubble).getByText(delivery.content as string)).toBeInTheDocument();
    expect(screen.getByText(/^You •/)).toBeInTheDocument();
  });

  it('labels completion results and falls back to the sender conversation identity', () => {
    renderChat([{
      ...delivery,
      agentMessage: { ...delivery.agentMessage!, senderName: '   ', kind: 'completion' },
    }]);

    expect(screen.getByText(/^Result from research-conversation •/)).toBeInTheDocument();
    expect(screen.queryByText(/^You •/)).not.toBeInTheDocument();
  });

  it('retains sender attribution alongside nested subflow and lane identity', () => {
    renderChat([{
      ...delivery,
      depth: 1,
      subflowResult: {
        subflowId: 'research',
        subflowName: 'Research',
        laneTitle: 'Check migrations',
        laneIndex: 0,
        laneCount: 2,
        status: 'completed',
        conversationId: 'research-conversation',
      },
    }]);

    expect(screen.getByText(/^Message from Research agent •/)).toBeInTheDocument();
    expect(screen.getByText('Subflow step')).toBeInTheDocument();
    expect(screen.getByTestId('subflow-lane-chip')).toHaveTextContent('Check migrations (1/2)');
  });
});
