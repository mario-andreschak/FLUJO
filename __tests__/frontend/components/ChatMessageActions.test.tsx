/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
