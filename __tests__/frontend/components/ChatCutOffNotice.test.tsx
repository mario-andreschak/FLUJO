/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';
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

function renderChat(messages: FlujoChatMessage[]) {
  return render(
    <ThemeProvider theme={createAppTheme('light')}>
      <ChatMessages
        messages={messages}
        conversationId="conversation-cut-off"
        onToggleDisabled={() => undefined}
        onSplitConversation={() => undefined}
      />
    </ThemeProvider>,
  );
}

const cutOffText = 'The answer was cut off because it hit the length limit. Ask it to continue.';

it('shows a soft notice, not an error, under a reply cut off by the length limit', () => {
  renderChat([
    { id: 'u', timestamp: 1, role: 'user', content: 'Tell me everything.' },
    { id: 'a', timestamp: 2, role: 'assistant', content: 'Here is the first part', cutOff: 'length' },
  ]);
  expect(screen.getByText('Here is the first part')).toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent(cutOffText);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows no notice under a reply that finished normally', () => {
  renderChat([{ id: 'a', timestamp: 2, role: 'assistant', content: 'All done.' }]);
  expect(screen.queryByText(cutOffText)).not.toBeInTheDocument();
});

const noAnswerText = 'The model finished without writing an answer. Ask again.';

it('shows a soft notice under a reply the model ended without an answer (#1419)', () => {
  renderChat([
    { id: 'u', timestamp: 1, role: 'user', content: 'When are you open?' },
    { id: 'a', timestamp: 2, role: 'assistant', content: '', noAnswer: true },
  ]);
  expect(screen.getByRole('note')).toHaveTextContent(noAnswerText);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows no such notice under a reply with an answer', () => {
  renderChat([{ id: 'a', timestamp: 2, role: 'assistant', content: 'Open from 8 to 18.' }]);
  expect(screen.queryByText(noAnswerText)).not.toBeInTheDocument();
});
