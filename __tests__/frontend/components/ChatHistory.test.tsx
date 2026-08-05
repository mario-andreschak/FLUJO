import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import ChatHistory from '@/frontend/components/Chat/ChatHistory';

jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => ({ visualStyle: 'modern' }),
}));

describe('ChatHistory', () => {
  it('offers another page when unloaded conversations remain', () => {
    const onLoadMore = jest.fn(async () => undefined);
    render(
      <ThemeProvider theme={createTheme()}>
        <ChatHistory
          conversations={[]}
          totalConversations={51}
          hasMoreConversations
          onLoadMore={onLoadMore}
          currentConversationId={null}
          onSelectConversation={jest.fn()}
          onDeleteConversation={jest.fn()}
          onBulkDelete={jest.fn(async () => undefined)}
          onNewConversation={jest.fn()}
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more conversations' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('keeps the delete action above the full-row conversation button', () => {
    const onDeleteConversation = jest.fn();
    const onSelectConversation = jest.fn();

    render(
      <ThemeProvider theme={createTheme()}>
        <ChatHistory
          conversations={[{
            id: 'conversation-1',
            title: 'Conversation one',
            flowId: null,
            createdAt: 1,
            updatedAt: 1,
            status: 'completed',
            source: 'chat',
          }]}
          currentConversationId="conversation-1"
          onSelectConversation={onSelectConversation}
          onDeleteConversation={onDeleteConversation}
          onBulkDelete={jest.fn(async () => undefined)}
          onNewConversation={jest.fn()}
        />
      </ThemeProvider>,
    );

    const deleteButton = screen.getByRole('button', { name: 'Delete conversation' });
    const secondaryAction = deleteButton.closest('.MuiListItemSecondaryAction-root');

    expect(secondaryAction).not.toBeNull();
    expect(secondaryAction).toHaveStyle({ zIndex: '2' });

    fireEvent.click(deleteButton);
    expect(onDeleteConversation).toHaveBeenCalledWith('conversation-1');
    expect(onSelectConversation).not.toHaveBeenCalled();
  });
});
