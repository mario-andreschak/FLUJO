/** @jest-environment jsdom */
/**
 * The tool approval card in the chat (#1284, R12): it names each tool and shows
 * its arguments, is a labelled region whose help line is read out when it
 * appears, and each Approve or Reject button says which tool it decides.
 * The keyboard part (Tab, Enter, visible focus) runs in a real browser in
 * scripts/tool-approval-journey.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ThemeProvider } from '@mui/material/styles';
import ChatMessages from '@/frontend/components/Chat/ChatMessages';
import { createAppTheme } from '@/frontend/utils/muiTheme';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({ __esModule: true, default: () => null }));

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) },
});

function renderCard(onApprove = jest.fn(), onReject = jest.fn()) {
  render(
    <ThemeProvider theme={createAppTheme('light')}>
      <ChatMessages
        messages={[]}
        conversationId="conversation-approval"
        onToggleDisabled={() => undefined}
        onSplitConversation={() => undefined}
        pendingToolCalls={[call('call-read', 'read_file', { path: 'notes.txt' }), call('call-write', 'write_file', { path: 'out.txt' })]}
        onApproveToolCall={onApprove}
        onRejectToolCall={onReject}
      />
    </ThemeProvider>,
  );
  return { onApprove, onReject };
}

it('is a labelled region that announces itself and shows each tool with its arguments', () => {
  renderCard();

  const card = screen.getByRole('region', { name: 'Tool approval required' });
  expect(within(card).getByRole('status')).toHaveTextContent('Approve or reject each request.');
  expect(within(card).getByText('read_file')).toBeInTheDocument();
  expect(within(card).getByText(/"path": "notes.txt"/)).toBeInTheDocument();
  expect(within(card).getByText('write_file')).toBeInTheDocument();
});

it('lets each button say which tool it decides, and decides only that call', () => {
  const { onApprove, onReject } = renderCard();

  const approvals = screen.getAllByRole('button', { name: 'Approve' });
  const rejections = screen.getAllByRole('button', { name: 'Reject' });
  expect(approvals.map((button) => button.getAttribute('aria-describedby') && document.getElementById(button.getAttribute('aria-describedby')!)?.textContent))
    .toEqual(['read_file', 'write_file']);
  expect(rejections[1]).toHaveAccessibleDescription('write_file');

  fireEvent.click(approvals[0]);
  fireEvent.click(rejections[1]);

  expect(onApprove).toHaveBeenCalledWith('call-read');
  expect(onReject).toHaveBeenCalledWith('call-write');
});
